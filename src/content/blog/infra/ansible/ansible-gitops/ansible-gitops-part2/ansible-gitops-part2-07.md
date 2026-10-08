---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第7回：planのレビューと承認ゲート'
description: 'プルリクエストで確認したplanと、マージの後に適用される内容が食い違う構造を確認し、保存したplanを適用する方法と、保存した後にtfstateが変わった場合の扱いを確かめる。Ansibleの`--check --diff`を承認の材料にしたときに見えない変更を示したうえで、適用系を手動で起動するワークフローに分離し、起動の操作を承認とする承認ゲートを設計する。'
pubDate: 2026-10-08
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'GitHub Actions', '承認ゲート']
seriesId: 'ansible-gitops-part2'
seriesNo: 7
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/'
relatedSeries: ''
---


<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>


> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第2部まとめブログ：GitOpsパイプラインで「見たものだけが、承認したときだけ届く」仕組みを積み上げる** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [プルリクエストで見たplanが適用されるとは限らない](#2-プルリクエストで見たplanが適用されるとは限らない)
3. [保存したplanを適用する](#3-保存したplanを適用する)
4. [Ansibleの確認モードはplanではない](#4-ansibleの確認モードはplanではない)
5. [手動起動を承認ゲートにする](#5-手動起動を承認ゲートにする)
6. [手動起動とGitOpsの原則](#6-手動起動とgitopsの原則)
7. [コードのレビューと実行の承認](#7-コードのレビューと実行の承認)
8. [クラウドプロバイダーでもゲートの設計は変わらない](#8-クラウドプロバイダーでもゲートの設計は変わらない)
9. [まとめ](#9-まとめ)
10. [次回予告](#10-次回予告)
11. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#11-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

AnsibleとTerraformのパイプラインで、プルリクエストでは確認系を、マージでは適用系を動かしていて、

* プルリクエストで、`terraform plan`と`ansible-playbook --check`の結果を確認した
* 問題がなかったので、mainにマージした
* マージの後には、確認したとおりの変更が適用される

と考えていないでしょうか。

planをCIで扱う記事の多くは、プルリクエストにplanの結果を表示するところまでを扱っています。表示したplanと、実際に適用される内容が一致するかや、適用の前に誰が承認するかは、あまり扱われていません。プルリクエストの確認とマージの適用をパイプラインで動かし始めると、次のような場面にぶつかります。

* マージの後の`terraform apply`に、プルリクエストで確認したplanにはなかった変更が含まれていた
* マージした時点で適用が始まり、適用の前に内容を確かめる機会がなかった
* `--check`の結果では変更がなかったのに、本実行で設定が変わった
* 適用の前に承認を挟もうとしたが、リポジトリの条件によっては、承認の機能が使えなかった

これらは、確認の手順が足りない問題に見えます。共通しているのは、確認した内容と適用される内容が同じであることも、適用の前に人が承認したことも、パイプラインの構造として保証されていない点です。

確認モードの限界は、**[「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜](https://qiita.com/juehara-crypto/items/d77fa93e82ea4a33ef4f)**（以下、冪等性シリーズ）と、**[「Ansibleは冪等なのに、なぜサーバは壊れていくのか」](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)**（以下、ドリフトシリーズ）で扱ってきました。冪等性シリーズの **[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/)** では、`register`と`when`の組み合わせによって、後続のタスクを実行するかどうかが、システムの現在の状態ではなく、直前のタスクの実行結果で決まる構造を確認しました。**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-09/)** では、`--check`では`shell`や`command`のタスクがスキップされ、変更が検出されないことと、`register`と`when`を使った構成では、`--check`の経路と実際の実行の経路が食い違う場合があることを整理しました。同じ **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-09/)** では、`--diff`は差分の内容を表示するだけで、その差分が意図どおりかの判断は人に委ねられることも整理しています。ドリフトシリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** では、`--check`で検知できるのは、Playbookが管理している範囲の差分に限られることを実機で確認しました。これらの回は、`--check`を冪等性やドリフトの確認の手段として見たときの限界を扱ったもので、パイプラインの中で、適用の前に人が判断する材料として見たときに何が足りないかは扱っていません。

本シリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5では、この検証環境の非公開リポジトリでは、ブランチ保護のルールを作成しても強制されず、mainへの直接プッシュを止められないことを確認しました。そのうえで、強制する場所を「mainに入る前」から「インフラに適用する前」に移し、適用しようとするコミットがプルリクエストを通ってmainに入ったものかを、適用するワークフローの側で確認するとしました。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** では、プルリクエストで確認し、マージで適用するパイプラインの骨格を組みました。同じ **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション4では、プルリクエストを通さずにmainへ直接プッシュしたコミットでも、適用系がそのまま動くことを確認しました。セクション7では、planの内容を見て、適用してよいかを判断する場所がないことを、暫定のまま残る部分として整理しています。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** では、tfstateをpgバックエンドに移し、パイプラインの実行を直列化しました。その検証の中で、プルリクエストの確認の実行が待機中に取り消され、確認が一度も動かないまま、マージされて適用されたプルリクエストが出ました。

第7回となる今回は、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** から残している、マージすれば適用されるという流れの間に、承認のゲートを設けます。まず、プルリクエストで確認したplanと、マージの後に適用される内容が、どのような場合に食い違うかを確認します。次に、`terraform plan -out`で保存したplanを適用する方法と、保存した後にtfstateが変わった場合の扱いを確認します。一方、Ansibleの`--check`には、結果を保存して後から適用する仕組みがありません。`--check --diff`の出力を承認の材料にしたときに、承認する人に何が見えて、何が見えないかを、パイプラインの中で確かめます。そのうえで、適用系をマージから切り離して手動で起動するワークフロー（`workflow_dispatch`）に移し、起動の操作を承認とする承認ゲートを組みます。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で適用の前に移すとした、プルリクエストを通ったコミットかの確認も、このゲートの入口に置きます。リポジトリの条件によって使える標準の承認の機能は、同じゲートを作る方法として併記します。

正確に言うと、**適用の前に必要なのは、確認の手順を増やすことではなく、レビューした内容だけを、承認したときにだけ適用する仕組みです**。この回で扱う問いは、「レビューした内容だけを、承認したときだけ適用するには、何が必要なのか」です。

次のセクションでは、プルリクエストで確認したplanと、マージの後に適用される内容が食い違う様子を確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. プルリクエストで見たplanが適用されるとは限らない

プルリクエストの確認で表示したplanと、マージの後に適用される内容が食い違う場合を、実機で確認します。

### 確認と適用は、別々の時点のmainに対して計算される

**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション4で確認したとおり、`pull_request`をきっかけに動くワークフローは、プルリクエストをmainにマージした結果（`refs/pull/プルリクエストの番号/merge`）に対して実行されます。プルリクエストの確認で表示されるplanは、確認の実行が動いた時点のmainにマージした結果と、その時点のtfstateから計算されたものです。

公式ドキュメント（**[Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)**）では、`pull_request`のワークフローが既定で動くのは、活動の種類が`opened`、`synchronize`、`reopened`のときだけとされています。プルリクエストが作られたとき、プルリクエストのブランチが更新されたとき、閉じたプルリクエストが再び開かれたときです。マージ先のmainが先に進んだことは、この中に含まれません。

一方、マージの後の`terraform apply`は、マージした時点のmainと、その時点のtfstateから、計画を計算し直します。確認からマージまでの間に、別のプルリクエストがmainに入れば、適用される内容は、確認で表示したplanと同じとは限りません。

### ■ 検証内容：先にマージされた変更と、レビューしたplanのずれ

次の3つのプルリクエストを使います。リソースには、何も作らない組み込みのリソース`terraform_data`を使い、操作対象には触れません。

|プルリクエスト|内容|
|---|---|
|準備|`terraform/gitops07.tf`に、値を1つ持つ`locals`だけを置く|
|A|`gitops07.tf`に、`locals`の値を`input`に使う`terraform_data`を加える|
|B|`locals`の値を`"v1"`から`"v2"`に変える|

準備のプルリクエストをマージした後、AとBを同じmainから作ります。そのうえで、Bを先にマージし、その後にAをマージします。

まず、準備のブランチで、`locals`だけを置いたファイルを作り、手元で計画を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops07-review-base
cat > terraform/gitops07.tf <<'EOF'
locals {
  gitops07_label = "v1"
}
EOF
git --no-pager diff --stat; git status --short
cd terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform plan
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops07-review-base'
?? terraform/gitops07.tf
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
```

`locals`だけでは、計画には何も現れません。このファイルをプルリクエスト（`#26`）にしてマージしました（マージコミット`90d34d1`）。

次に、このmainから、ブランチAとブランチBを作ります。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops07-review-a
cat >> terraform/gitops07.tf <<'EOF'

resource "terraform_data" "gitops07_review" {
  input = local.gitops07_label
}
EOF
git --no-pager diff
cd terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform plan
cd ..
git add terraform/gitops07.tf
git commit -m "GitOps第7回: localsを参照するterraform_dataを追加"
git push -u origin gitops07-review-a
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops07-review-a'
diff --git a/terraform/gitops07.tf b/terraform/gitops07.tf
index d01b642..f725a56 100644
--- a/terraform/gitops07.tf
+++ b/terraform/gitops07.tf
@@ -1,3 +1,7 @@
 locals {
   gitops07_label = "v1"
 }
+
+resource "terraform_data" "gitops07_review" {
+  input = local.gitops07_label
+}
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # terraform_data.gitops07_review will be created
  + resource "terraform_data" "gitops07_review" {
      + id     = (known after apply)
      + input  = "v1"
      + output = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.

（途中省略：区切り線と-outオプションに関する注意書き、コミットとプッシュの表示）
```

**実行コマンド**

```plaintext
git switch main
git switch -c gitops07-review-b
sed -i 's/gitops07_label = "v1"/gitops07_label = "v2"/' terraform/gitops07.tf
git --no-pager diff
cd terraform
terraform plan
cd ..
git add terraform/gitops07.tf
git commit -m "GitOps第7回: localsの値をv2に変更"
git push -u origin gitops07-review-b
git switch main
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Switched to a new branch 'gitops07-review-b'
diff --git a/terraform/gitops07.tf b/terraform/gitops07.tf
index d01b642..e596584 100644
--- a/terraform/gitops07.tf
+++ b/terraform/gitops07.tf
@@ -1,3 +1,3 @@
 locals {
-  gitops07_label = "v1"
+  gitops07_label = "v2"
 }
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
（途中省略：コミットとプッシュの表示）
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
```

Bの変更は`locals`の値だけで、その値を参照するリソースはmainにまだないため、計画には何も現れません。

ブランチAからプルリクエスト（`#27`）を、ブランチBからプルリクエスト（`#28`）を、この順に作成しました。`#27`の確認として「GitOps Pipeline」の実行（`#46`）が、`#28`の確認として実行（`#47`）が起動しました。実行の番号は、プルリクエストの番号とは別に、ワークフローのすべての実行を通して振られます。

**▼ 実行結果（プルリクエスト`#27`の実行`#46`、`terraform-plan`ジョブのステップ「Terraform plan」から抜粋）**

```plaintext
Run terraform plan -input=false
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # terraform_data.gitops07_review will be created
  + resource "terraform_data" "gitops07_review" {
      + id     = (known after apply)
      + input  = "v1"
      + output = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.

（途中省略：区切り線と-outオプションに関する注意書き）
```

**▼ 実行結果（プルリクエスト`#28`の実行`#47`、`terraform-plan`ジョブのステップ「Terraform plan」から抜粋）**

```plaintext
Run terraform plan -input=false
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.
```

どちらの実行も成功しました。`#27`のレビューで見えるのは`input = "v1"`での作成、`#28`のレビューで見えるのは「No changes」です。

続いて、`#28`（B）を先にマージしました（マージコミット`63a0686`）。このマージで起動した実行（`#48`）は、次のとおりです。

**▼ 実行結果（`#28`のマージの実行`#48`、`terraform-apply`ジョブのステップ「Terraform apply」から抜粋）**

```plaintext
Run terraform apply -input=false -auto-approve
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

（途中省略：Outputsの表示）
```

その後に、`#27`（A）をマージしました（マージコミット`c5b6c37`）。このマージで起動した実行（`#49`）は、次のとおりです。

**▼ 実行結果（`#27`のマージの実行`#49`、`terraform-apply`ジョブのステップ「Terraform apply」から抜粋）**

```plaintext
Run terraform apply -input=false -auto-approve
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # terraform_data.gitops07_review will be created
  + resource "terraform_data" "gitops07_review" {
      + id     = (known after apply)
      + input  = "v2"
      + output = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.
terraform_data.gitops07_review: Creating...
terraform_data.gitops07_review: Creation complete after 0s [id=9f72aa57-e553-2d75-dfaf-6c7d7b9971c5]

Apply complete! Resources: 1 added, 0 changed, 0 destroyed.

（途中省略：Outputsの表示）
```

次の画像は、「GitOps Pipeline」の実行の一覧です。`#26`のマージの実行（`#45`）、`#27`の確認の実行（`#46`）、`#28`の確認の実行（`#47`）、`#28`のマージの実行（`#48`）、`#27`のマージの実行（`#49`）が写っています。`#28`のマージ（`#48`）の後に、`#27`の確認の実行は新しく起動していません。

![GitOps Pipelineの実行の一覧。#26のマージの実行#45、#27の確認の実行#46、#28の確認の実行#47、#28のマージの実行#48、#27のマージの実行#49がすべて成功し、#48の後に#27の確認は再実行されていない](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/section2-review-runs.png)

### ■ 結果

4つの実行で、`terraform_data.gitops07_review`がどう扱われたかを並べると、次のとおりです。

|実行|きっかけ|`terraform_data.gitops07_review`|
|---|---|---|
|`#46`|`#27`（A）の確認|`input = "v1"`で作成する計画|
|`#47`|`#28`（B）の確認|計画に現れない（「No changes」）|
|`#48`|`#28`（B）のマージ|適用なし（「No changes」）|
|`#49`|`#27`（A）のマージ|`input = "v2"`で作成|

インフラに適用されたのは、`input = "v2"`のリソースでした。`#27`のレビューで見えたのは`input = "v1"`、`#28`のレビューで見えたのは「No changes」で、`input = "v2"`のリソースは、どちらのレビューにも現れていません。

それぞれのplanは、計算した時点では正しいものでした。`#27`の確認は、Bが入る前のmainにAをマージした結果に対して計算されています。`#28`の確認では、変えた値を参照するリソースがまだなかったため、計画に何も現れませんでした。食い違いは、2つの変更がmainの上で組み合わさった結果を、誰もレビューしていないことから生まれています。

Bのマージの後も、`#27`の確認は再実行されず、`#46`の結果のまま成功と表示されていました。公式ドキュメントのとおり、mainが先に進んだことは、`pull_request`の確認が動く条件に含まれないためです。プルリクエストの画面に表示されている確認の結果は、そのプルリクエストを今のmainにマージした結果を表しているとは限りません。

なお、パイプラインの動きそのものに誤りはありません。`#48`も`#49`も、それぞれの時点のmainを正しく適用しています。問題は、適用される内容を、適用の前に誰も見ていないことです。

この検証では、Gitの中の変更の順序によるずれを確認しました。確認からマージまでの間に、手元から実行した`terraform apply`や、Gitを経由しない変更でtfstateや操作対象が変わった場合も、マージの後の`terraform apply`は、その時点の状態から計算し直します。この場合も、レビューしたplanと適用される内容は食い違いうることになります（この経路は、仕組みからの導出で、実機では確認していません）。

### ■ 検証内容：確認用のリソースの削除

確認に使った`terraform/gitops07.tf`を削除し、`terraform_data.gitops07_review`を破棄します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline --graph -5
git switch -c gitops07-review-cleanup
git rm terraform/gitops07.tf
cd terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform plan
```

**▼ 実行結果**

```plaintext
Already on 'main'
Your branch is up to date with 'origin/main'.
（途中省略：オブジェクトの受信の表示）
From https://github.com/juehara-crypto/ansible-terraform-ci-lab
   90d34d1..c5b6c37  main       -> origin/main
Updating 90d34d1..c5b6c37
Fast-forward
 terraform/gitops07.tf | 6 +++++-
 1 file changed, 5 insertions(+), 1 deletion(-)
*   c5b6c37 (HEAD -> main, origin/main) Merge pull request #27 from juehara-crypto/gitops07-review-a
|\
| * faeab9f (origin/gitops07-review-a, gitops07-review-a) GitOps第7回: localsを参照するterraform_dataを追加
* |   63a0686 Merge pull request #28 from juehara-crypto/gitops07-review-b
|\ \
| |/
|/|
| * 479aa02 (origin/gitops07-review-b, gitops07-review-b) GitOps第7回: localsの値をv2に変更
|/
*   90d34d1 Merge pull request #26 from juehara-crypto/gitops07-review-base
|\
Switched to a new branch 'gitops07-review-cleanup'
rm 'terraform/gitops07.tf'
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  - destroy

Terraform will perform the following actions:

  # terraform_data.gitops07_review will be destroyed
  # (because terraform_data.gitops07_review is not in configuration)
  - resource "terraform_data" "gitops07_review" {
      - id     = "9f72aa57-e553-2d75-dfaf-6c7d7b9971c5" -> null
      - input  = "v2" -> null
      - output = "v2" -> null
    }

Plan: 0 to add, 0 to change, 1 to destroy.

（途中省略：区切り線と-outオプションに関する注意書き）
```

mainの履歴でも、`#28`のマージ（`63a0686`）の後に、`#27`のマージ（`c5b6c37`）が入っています。計画は、`input = "v2"`の`terraform_data.gitops07_review`の破棄だけでした。この変更をコミットしてプルリクエスト（`#29`）にし、マージしました（マージコミット`a474aa5`）。

**▼ 実行結果（`#29`のマージの実行`#51`、`terraform-apply`ジョブのステップ「Terraform apply」から抜粋）**

```plaintext
Run terraform apply -input=false -auto-approve
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力、計画の表示）

Plan: 0 to add, 0 to change, 1 to destroy.
terraform_data.gitops07_review: Destroying... [id=9f72aa57-e553-2d75-dfaf-6c7d7b9971c5]
terraform_data.gitops07_review: Destruction complete after 0s

Apply complete! Resources: 0 added, 0 changed, 1 destroyed.

（途中省略：Outputsの表示）
```

### ■ 結果

確認用のリソースは破棄され、mainから`gitops07.tf`がなくなりました。

この検証で分かったのは、プルリクエストで確認したplanは「確認した時点のmainとtfstateに対する計画」であり、マージの後に適用されるのは「マージした時点のmainとtfstateに対する計画」だということです。今のパイプラインは、マージの後の`terraform apply`で計画を計算し直し、そのまま適用します。そのため、レビューした計画と適用する計画が同じであることを確かめる場所がありません。

次のセクションでは、計画を保存し、保存した計画そのものを適用する方法を確認します。

---

[↑ 目次に戻る](#-目次)

---

## 3. 保存したplanを適用する

レビューしたplanそのものを適用する方法として、Terraformの保存したplanを、手元で確認します。

### 保存したplanは、計画を作った時点の内容を持っている

公式ドキュメント（**[terraform plan](https://developer.hashicorp.com/terraform/cli/commands/plan)**）では、`terraform plan`に`-out`を付けると、作った計画をファイルに保存でき、そのファイルを`terraform apply`に渡して後から実行できるとされています。この2段階の流れは、主に自動化の中で`terraform`を実行する場合を想定したものです。同じページでは、保存しないplanについて、その間に対象に加えられた別の変更によって最終的な効果が変わりうるため、適用の前に保存したplanで確かめ直すよう書かれています。**[セクション2](#2-プルリクエストで見たplanが適用されるとは限らない)** で確認したずれは、この説明のとおりの動きです。

**[terraform apply](https://developer.hashicorp.com/terraform/cli/commands/apply)** のページでは、保存したplanを渡した`terraform apply`は、確認のプロンプトを出さずに、保存した計画の操作を実行するとされています。planファイルを渡すこと自体が承認とみなされ、`-auto-approve`は無視されます。

一方、保存したplanのファイルには、設定の全体、計画した変更に関わる値、入力変数を含む計画の指定が含まれます。機密の値も、画面の表示では伏せられていても、ファイルには平文で保存されるため、保存したplanは機密を含みうるものとして扱うよう書かれています。この検証では、planファイルをリポジトリの外の、本人だけが読めるディレクトリに保存し、中身は表示しません。

### ■ 検証内容：保存した後に設定を書き換えて、保存したplanを適用する

確認用のファイルに`terraform_data`を置き、`input = "v1"`の計画を保存します。このファイルはコミットせず、検証の最後に削除します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git status --short
mkdir -p -m 700 ~/gitops07-plans
cat > terraform/gitops07_saved.tf <<'EOF'
resource "terraform_data" "gitops07_saved" {
  input = "v1"
}
EOF
cd terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
(umask 077; terraform plan -out=$HOME/gitops07-plans/tfplan-v1)
ls -la ~/gitops07-plans/
unzip -l ~/gitops07-plans/tfplan-v1
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # terraform_data.gitops07_saved will be created
  + resource "terraform_data" "gitops07_saved" {
      + id     = (known after apply)
      + input  = "v1"
      + output = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.

（途中省略：区切り線）

Saved the plan to: /home/control/gitops07-plans/tfplan-v1

To perform exactly these actions, run the following command to apply:
    terraform apply "/home/control/gitops07-plans/tfplan-v1"
total 24
drwx------  2 control control  4096 Oct  8 00:46 .
drwxr-x--- 13 control control  4096 Oct  8 00:46 ..
-rw-------  1 control control 15162 Oct  8 00:46 tfplan-v1
Command 'unzip' not found, but can be installed with:
sudo apt install unzip
```

最初の`git status --short`は何も出力せず、作業ツリーに変更がない状態から始めています。計画は`input = "v1"`での作成として保存され、planファイルは`-rw-------`になりました。

`unzip`が入っていなかったため、Python 3の標準ライブラリで、planファイルの中にあるファイルの名前と大きさだけを表示します。そのうえで、確認用のファイルを`input = "v2"`に書き換えてから、保存したplanを適用します。

**実行コマンド**

```plaintext
python3 -c 'import sys, zipfile; [print(i.file_size, i.filename) for i in zipfile.ZipFile(sys.argv[1]).infolist()]' $HOME/gitops07-plans/tfplan-v1
sed -i 's/input = "v1"/input = "v2"/' gitops07_saved.tf
cat gitops07_saved.tf
terraform apply $HOME/gitops07-plans/tfplan-v1
terraform state show terraform_data.gitops07_saved
```

**▼ 実行結果**

```plaintext
12785 tfplan
28712 tfstate
28676 tfstate-prev
62 tfconfig/m-/gitops07_saved.tf
3739 tfconfig/m-/main.tf
497 tfconfig/m-/outputs.tf
41 tfconfig/modules.json
2485 .terraform.lock.hcl
resource "terraform_data" "gitops07_saved" {
  input = "v2"
}
terraform_data.gitops07_saved: Creating...
terraform_data.gitops07_saved: Creation complete after 0s [id=e811d69b-9553-a374-9d6f-9f47e9a460d2]

Apply complete! Resources: 1 added, 0 changed, 0 destroyed.

（途中省略：Outputsの表示）
# terraform_data.gitops07_saved:
resource "terraform_data" "gitops07_saved" {
    id     = "e811d69b-9553-a374-9d6f-9f47e9a460d2"
    input  = "v1"
    output = "v1"
}
```

### ■ 結果

ファイルは`input = "v2"`に書き換わっていましたが、適用されたのは、保存した計画の`input = "v1"`でした。保存したplanの適用では、確認のプロンプトは出ず、`Refreshing state...`の行も出ずに、保存した操作がそのまま実行されています。

planファイルの中には、計画そのもの（`tfplan`）に加えて、計画を作った時点のtfstateの写し（`tfstate`、`tfstate-prev`）、`.tf`ファイルの写し（`tfconfig/`の下）、ロックファイルが入っていました。保存したplanは、計画を作った時点の設定とtfstateを持っているため、その後に設定が変わっても、レビューした計画のとおりに適用されます。

裏を返すと、保存したplanは、設定が変わっただけでは止まりません。適用の時点のmainと、保存したplanの内容が同じであることは、保存したplanの仕組みだけでは保証されないということです。この点は、**[セクション5](#5-手動起動を承認ゲートにする)** で、planを作るコミットと適用するコミットの関係として扱います。

なお、この検証環境のtfstateには、Ansibleの接続に使う鍵を作る`tls_private_key.generated`の秘密鍵が含まれています。planファイルにtfstateの写しが入っている以上、planファイルにも秘密鍵が含まれていると考えられます（中身は表示していないため、ファイルの一覧と公式ドキュメントの記述からの推測です）。保存したplanをどこに置くかは、**[セクション5](#5-手動起動を承認ゲートにする)** で決め、機密情報としての扱いは、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

### ■ 検証内容：同じtfstateから作った2つのplanを、順に適用する

**[セクション2](#2-プルリクエストで見たplanが適用されるとは限らない)** では、2つのプルリクエストの確認が、同じ時点のmainとtfstateに対して並行して行われ、片方が先に適用されました。同じ形を、保存したplanで再現します。今のtfstateは`input = "v1"`、ファイルは`input = "v2"`です。ここから`"v2"`の計画と`"v3"`の計画を続けて保存し、`"v3"`を先に適用した後に、`"v2"`を適用します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git status --short
cd terraform
(umask 077; terraform plan -out=$HOME/gitops07-plans/tfplan-v2)
sed -i 's/input = "v2"/input = "v3"/' gitops07_saved.tf
cat gitops07_saved.tf
(umask 077; terraform plan -out=$HOME/gitops07-plans/tfplan-v3)
terraform apply $HOME/gitops07-plans/tfplan-v3
terraform apply $HOME/gitops07-plans/tfplan-v2; echo "exit_code=$?"
terraform state show terraform_data.gitops07_saved
```

**▼ 実行結果**

```plaintext
?? terraform/gitops07_saved.tf
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  ~ update in-place

Terraform will perform the following actions:

  # terraform_data.gitops07_saved will be updated in-place
  ~ resource "terraform_data" "gitops07_saved" {
        id     = "e811d69b-9553-a374-9d6f-9f47e9a460d2"
      ~ input  = "v1" -> "v2"
      ~ output = "v1" -> (known after apply)
    }

Plan: 0 to add, 1 to change, 0 to destroy.

（途中省略：区切り線）

Saved the plan to: /home/control/gitops07-plans/tfplan-v2

To perform exactly these actions, run the following command to apply:
    terraform apply "/home/control/gitops07-plans/tfplan-v2"
resource "terraform_data" "gitops07_saved" {
  input = "v3"
}
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  ~ update in-place

Terraform will perform the following actions:

  # terraform_data.gitops07_saved will be updated in-place
  ~ resource "terraform_data" "gitops07_saved" {
        id     = "e811d69b-9553-a374-9d6f-9f47e9a460d2"
      ~ input  = "v1" -> "v3"
      ~ output = "v1" -> (known after apply)
    }

Plan: 0 to add, 1 to change, 0 to destroy.

（途中省略：区切り線）

Saved the plan to: /home/control/gitops07-plans/tfplan-v3

To perform exactly these actions, run the following command to apply:
    terraform apply "/home/control/gitops07-plans/tfplan-v3"
terraform_data.gitops07_saved: Modifying... [id=e811d69b-9553-a374-9d6f-9f47e9a460d2]
terraform_data.gitops07_saved: Modifications complete after 0s [id=e811d69b-9553-a374-9d6f-9f47e9a460d2]

Apply complete! Resources: 0 added, 1 changed, 0 destroyed.

（途中省略：Outputsの表示）
╷
│ Error: Saved plan is stale
│
│ The given plan file can no longer be applied because the state was changed by another operation after the plan was created.
╵
exit_code=1
# terraform_data.gitops07_saved:
resource "terraform_data" "gitops07_saved" {
    id     = "e811d69b-9553-a374-9d6f-9f47e9a460d2"
    input  = "v3"
    output = "v3"
}
```

### ■ 結果

2つのplanの扱いを並べると、次のとおりです。

|planファイル|計画を作った時点のtfstate|計画|適用の結果|
|---|---|---|---|
|`tfplan-v2`|`input = "v1"`|`"v1" -> "v2"`|後から適用し、`Error: Saved plan is stale`で拒否（`exit_code=1`）|
|`tfplan-v3`|`input = "v1"`|`"v1" -> "v3"`|先に適用し、`"v3"`に変更|

`tfplan-v2`は、計画を作った後に、別の操作（`tfplan-v3`の適用）でtfstateが変わったため、古い計画として適用を拒否されました。tfstateは`input = "v3"`のままで、`tfplan-v2`の内容は何も適用されていません。

この拒否の動きは、`terraform plan`と`terraform apply`の公式ドキュメントには書かれておらず、この検証環境（Terraform v1.15.7、pgバックエンド）での実測です。

**[セクション2](#2-プルリクエストで見たplanが適用されるとは限らない)** の今のパイプラインでは、マージの後の`terraform apply`が計画を計算し直し、誰もレビューしていない内容をそのまま適用しました。保存したplanを適用する形にすると、計画を作った後にtfstateが変わった場合は、別の内容を適用するのではなく、適用そのものが止まります。保存したplanは、「レビューした計画だけを適用し、前提が変わったら止まる」という保証を与えます。

ただし、止まるきっかけはtfstateの変化です。最初の検証で見たとおり、設定が変わっただけでは、保存したplanは止まりません。

### ■ 検証内容：確認用のリソースの削除

確認用のファイルを削除し、`terraform_data.gitops07_saved`の破棄を、同じく保存したplanで行います。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
rm gitops07_saved.tf
(umask 077; terraform plan -out=$HOME/gitops07-plans/tfplan-cleanup)
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  - destroy

Terraform will perform the following actions:

  # terraform_data.gitops07_saved will be destroyed
  # (because terraform_data.gitops07_saved is not in configuration)
  - resource "terraform_data" "gitops07_saved" {
      - id     = "e811d69b-9553-a374-9d6f-9f47e9a460d2" -> null
      - input  = "v3" -> null
      - output = "v3" -> null
    }

Plan: 0 to add, 0 to change, 1 to destroy.

（途中省略：区切り線）

Saved the plan to: /home/control/gitops07-plans/tfplan-cleanup

To perform exactly these actions, run the following command to apply:
    terraform apply "/home/control/gitops07-plans/tfplan-cleanup"
```

**実行コマンド**

```plaintext
terraform apply $HOME/gitops07-plans/tfplan-cleanup
rm -r ~/gitops07-plans
ls -la ~/gitops07-plans; echo "exit_code=$?"
terraform plan -detailed-exitcode > /dev/null; echo "plan_exit_code=$?"
terraform state list | wc -l
cd ~/iac/docker-lab-ci
git status --short; echo "git_status_exit_code=$?"
```

**▼ 実行結果**

```plaintext
terraform_data.gitops07_saved: Destroying... [id=e811d69b-9553-a374-9d6f-9f47e9a460d2]
terraform_data.gitops07_saved: Destruction complete after 0s

Apply complete! Resources: 0 added, 0 changed, 1 destroyed.

（途中省略：Outputsの表示）
ls: cannot access '/home/control/gitops07-plans': No such file or directory
exit_code=2
plan_exit_code=0
10
git_status_exit_code=0
```

### ■ 結果

確認用のリソースとplanファイルは削除され、`terraform plan`は差分なし（`plan_exit_code=0`）、Terraformが把握しているリソースは10個、作業ツリーに変更はありません。検証の前と同じ状態に戻りました。

保存したplanを使えば、Terraformについては、レビューした計画だけを適用し、レビューの後にtfstateが変わった場合は止まる、という形を作れます。では、Ansibleにも同じ形を作れるのでしょうか。

次のセクションでは、Ansibleの確認モード（`--check --diff`）の出力を承認の材料にしたときに、何が見えて、何が見えないかを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 4. Ansibleの確認モードはplanではない

Ansibleの確認モード（`--check --diff`）の出力を承認の材料にしたときに、承認する人に何が見えて、何が見えないかを、パイプラインの中で確認します。

### 確認モードの出力は、保存して適用できない

**[セクション3](#3-保存したplanを適用する)** で確認したとおり、Terraformの保存したplanは、計画を作った時点の設定とtfstateを持ち、適用するとその計画のとおりに実行されます。計画を作った後にtfstateが変われば、適用そのものが止まります。

Ansibleの`--check`には、このように結果を保存して、後から適用する仕組みがありません。`--check`の出力は、その時点で実行したらどうなるかの予測です。本実行の`ansible-playbook`は、実行した時点の操作対象に対して、Playbookを最初から実行し直します。

この予測が本実行とずれる理由は、冪等性シリーズの **[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/)** と **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-09/)** で扱いました。`--check`では`shell`や`command`のタスクがスキップされること、`register`と`when`を使った構成では、`--check`がたどる経路と本実行の経路が食い違う場合があることです。ドリフトシリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** では、`--check`で検知できるのはPlaybookが管理している範囲に限られることを確認しました。ここでは、これらを再検証するのではなく、パイプラインの中で、承認する人が見る確認の実行のログと、承認の後の本実行のログを並べます。

### ■ 検証内容：確認の出力に見えるものと、本実行で変わるもの

1つのプルリクエストで、次の2つを変えます。

* ロールに、新しいタスクファイル`gitops07_review.yml`を加える。`copy`で`/etc/gitops07-copy.conf`を配置するタスクと、`shell`で`/etc/gitops07-shell.conf`を書き出すタスクの2つを置く
* `gitops-pipeline.yml`の確認系の`ansible-playbook`に`--diff`を加え、`--check --diff`にする。適用系にも`--diff`を加え、本実行で変わった内容もログに残す

既存の`drift_check.yml`には触れず、新しいタスクファイルを`main.yml`から読み込みます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops07-check-diff
cat > ansible/roles/common_setup/tasks/gitops07_review.yml <<'EOF'
---
- name: 承認の確認用の設定ファイルを配置（copy）
  become: true
  ansible.builtin.copy:
    dest: /etc/gitops07-copy.conf
    content: "written_by=copy\n"
    mode: "0644"

- name: 承認の確認用の設定ファイルを書き出す（shell）
  become: true
  ansible.builtin.shell: echo "written_by=shell" > /etc/gitops07-shell.conf
EOF
cat >> ansible/roles/common_setup/tasks/main.yml <<'EOF'
- name: gitops07_review.ymlを読み込み
  ansible.builtin.import_tasks: gitops07_review.yml
EOF
sed -i '80s/site\.yml --check$/site.yml --check --diff/; 117s/site\.yml$/site.yml --diff/' .github/workflows/gitops-pipeline.yml
git --no-pager diff
git status --short
cat -n ansible/roles/common_setup/tasks/gitops07_review.yml
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops07-check-diff'
diff --git a/.github/workflows/gitops-pipeline.yml b/.github/workflows/gitops-pipeline.yml
index 90cbc7a..a2ecd75 100644
--- a/.github/workflows/gitops-pipeline.yml
+++ b/.github/workflows/gitops-pipeline.yml
@@ -77,7 +77,7 @@ jobs:
           terraform -chdir=../terraform output -raw generated_private_key > id_ed25519_generated
       - name: Ansible check mode
         working-directory: ansible
-        run: ansible-playbook -i dynamic_inventory.py site.yml --check
+        run: ansible-playbook -i dynamic_inventory.py site.yml --check --diff
       - name: Remove private key
         if: always()
         working-directory: ansible
@@ -114,7 +114,7 @@ jobs:
           terraform -chdir=../terraform output -raw generated_private_key > id_ed25519_generated
       - name: Ansible playbook
         working-directory: ansible
-        run: ansible-playbook -i dynamic_inventory.py site.yml
+        run: ansible-playbook -i dynamic_inventory.py site.yml --diff
       - name: Remove private key
         if: always()
         working-directory: ansible
diff --git a/ansible/roles/common_setup/tasks/main.yml b/ansible/roles/common_setup/tasks/main.yml
index 46dcccd..d33b871 100644
--- a/ansible/roles/common_setup/tasks/main.yml
+++ b/ansible/roles/common_setup/tasks/main.yml
@@ -1,3 +1,5 @@
 ---
 - name: drift_check.ymlを読み込み
   ansible.builtin.import_tasks: drift_check.yml
+- name: gitops07_review.ymlを読み込み
+  ansible.builtin.import_tasks: gitops07_review.yml
 M .github/workflows/gitops-pipeline.yml
 M ansible/roles/common_setup/tasks/main.yml
?? ansible/roles/common_setup/tasks/gitops07_review.yml
     1  ---
     2  - name: 承認の確認用の設定ファイルを配置（copy）
     3    become: true
     4    ansible.builtin.copy:
     5      dest: /etc/gitops07-copy.conf
     6      content: "written_by=copy\n"
     7      mode: "0644"
     8
     9  - name: 承認の確認用の設定ファイルを書き出す（shell）
    10    become: true
    11    ansible.builtin.shell: echo "written_by=shell" > /etc/gitops07-shell.conf
```

`shell`のタスクは、実行のたびにファイルを書き出すため、毎回`changed`になります。冪等性シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** で扱った、現在の状態を見ないタスクの形で、ここでは承認の材料に現れない変更の例として使います。

コミットの前に、操作対象に確認用のファイルがないことを確認します。

**実行コマンド**

```plaintext
for n in target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n sh -c 'ls -l /etc/gitops07-*'; done
git add .github/workflows/gitops-pipeline.yml ansible/roles/common_setup/tasks/main.yml ansible/roles/common_setup/tasks/gitops07_review.yml
git commit -m "GitOps第7回: 確認用のcopyとshellのタスクを追加し、ansible-playbookに--diffを付ける"
git push -u origin gitops07-check-diff
```

**▼ 実行結果**

```plaintext
== target-node1
ls: cannot access '/etc/gitops07-*': No such file or directory
== target-node2
ls: cannot access '/etc/gitops07-*': No such file or directory
== target-node3
ls: cannot access '/etc/gitops07-*': No such file or directory
[gitops07-check-diff f384e00] GitOps第7回: 確認用のcopyとshellのタスクを追加し、ansible-playbookに--diffを付ける
 3 files changed, 15 insertions(+), 2 deletions(-)
 create mode 100644 ansible/roles/common_setup/tasks/gitops07_review.yml
（途中省略：プッシュの表示）
```

このブランチから、プルリクエスト（`#30`）を作成しました。ワークフローのファイルも`ansible/`も変えているため、確認の実行（`#52`）は、`--diff`を加えた後のワークフローで、`ansible-check`まで動きました。承認する人が見るのは、次のログです。

**▼ 実行結果（プルリクエスト`#30`の実行`#52`、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示）

PLAY [接続確認用Playbook] ******************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
（途中省略：Pythonのインタープリターに関する警告）
ok: [target-node2]
ok: [target-node3]
ok: [target-node1]

TASK [common_setup : 承認の確認用の設定ファイルを配置（copy）] *****************
（途中省略：Pythonのインタープリターに関する警告の続き）
--- before
+++ after: /etc/gitops07-copy.conf
@@ -0,0 +1 @@
+written_by=copy

changed: [target-node2]
--- before
+++ after: /etc/gitops07-copy.conf
@@ -0,0 +1 @@
+written_by=copy

changed: [target-node1]
--- before
+++ after: /etc/gitops07-copy.conf
@@ -0,0 +1 @@
+written_by=copy

changed: [target-node3]

TASK [common_setup : 承認の確認用の設定ファイルを書き出す（shell）] ************
skipping: [target-node2]
skipping: [target-node3]
skipping: [target-node1]

TASK [疎通確認] ****************************************************************
ok: [target-node2]
ok: [target-node1]
ok: [target-node3]

PLAY RECAP *********************************************************************
target-node1               : ok=3    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0   
target-node2               : ok=3    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0   
target-node3               : ok=3    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0   
```

続いて、プルリクエスト`#30`をマージしました（マージコミット`b13d7be`）。このマージで起動した実行（`#53`）の本実行のログは、次のとおりです。

**▼ 実行結果（`#30`のマージの実行`#53`、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示）

PLAY [接続確認用Playbook] ******************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
（途中省略：Pythonのインタープリターに関する警告）
ok: [target-node1]
ok: [target-node2]
ok: [target-node3]

TASK [common_setup : 承認の確認用の設定ファイルを配置（copy）] *****************
--- before
+++ after: /etc/gitops07-copy.conf
@@ -0,0 +1 @@
+written_by=copy

changed: [target-node3]
--- before
+++ after: /etc/gitops07-copy.conf
@@ -0,0 +1 @@
+written_by=copy

changed: [target-node2]
--- before
+++ after: /etc/gitops07-copy.conf
@@ -0,0 +1 @@
+written_by=copy

changed: [target-node1]

TASK [common_setup : 承認の確認用の設定ファイルを書き出す（shell）] ************
changed: [target-node1]
changed: [target-node2]
changed: [target-node3]

TASK [疎通確認] ****************************************************************
ok: [target-node1]
ok: [target-node2]
ok: [target-node3]

PLAY RECAP *********************************************************************
target-node1               : ok=4    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=4    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=4    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

操作対象で、実際に何が書き込まれたかを確認します。

**実行コマンド**

```plaintext
for n in target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n sh -c 'ls -l /etc/gitops07-*; cat /etc/gitops07-copy.conf /etc/gitops07-shell.conf'; done
```

**▼ 実行結果**

```plaintext
== target-node1
-rw-r--r-- 1 root root 16 Oct  8 01:15 /etc/gitops07-copy.conf
-rw-r--r-- 1 root root 17 Oct  8 01:15 /etc/gitops07-shell.conf
written_by=copy
written_by=shell
== target-node2
-rw-r--r-- 1 root root 16 Oct  8 01:15 /etc/gitops07-copy.conf
-rw-r--r-- 1 root root 17 Oct  8 01:15 /etc/gitops07-shell.conf
written_by=copy
written_by=shell
== target-node3
-rw-r--r-- 1 root root 16 Oct  8 01:15 /etc/gitops07-copy.conf
-rw-r--r-- 1 root root 17 Oct  8 01:15 /etc/gitops07-shell.conf
written_by=copy
written_by=shell
```

### ■ 結果

2つのタスクについて、承認の材料（`#52`）、本実行（`#53`）、操作対象を並べると、次のとおりです。

|タスク|承認の材料（`--check --diff`）|本実行（`--diff`）|操作対象|
|---|---|---|---|
|`copy`|`changed`。書き込む内容を差分で表示|`changed`。同じ差分を表示|`/etc/gitops07-copy.conf`（`written_by=copy`）|
|`shell`|`skipping`|`changed`。差分の表示なし|`/etc/gitops07-shell.conf`（`written_by=shell`）|
|`PLAY RECAP`|`changed=1`、`skipped=1`|`changed=2`、`skipped=0`|―|

`copy`のタスクは、承認の材料の時点で、どのファイルに何が書き込まれるかが差分として見えていました。本実行でも同じ差分が表示され、操作対象のファイルの内容も一致しています。

一方、`shell`のタスクは、承認の材料では`skipping`と表示されただけで、何が起きるかは示されていません。`PLAY RECAP`の`skipped=1`から、確認されなかったタスクがあることは読み取れますが、そのタスクが何を変えるかは分かりません。本実行では`changed`になり、3台に`/etc/gitops07-shell.conf`が書き込まれました。しかも、`--diff`を付けた本実行のログでも、`shell`のタスクには差分が表示されていません。このファイルが書き込まれたことと、その内容は、承認の前にも、適用の記録にも現れず、操作対象を直接見て初めて分かりました。

Terraformと並べると、承認の観点での違いは次のとおりです。

|観点|Terraformの保存したplan|Ansibleの`--check --diff`|
|---|---|---|
|承認の材料|計画そのもの|実行したらどうなるかの予測|
|適用されるもの|保存した計画のとおり|適用の時点で、Playbookを最初から実行した結果|
|承認の後に前提が変わったとき|tfstateが変われば、適用が止まる（**[セクション3](#3-保存したplanを適用する)**）|止まらない。適用の時点の状態に対して実行する|
|材料に現れない変更|保存した計画にない操作は行われない|`shell`や`command`のタスク、`register`と`when`で経路が変わるタスク、Playbookの管理範囲の外の変化|

Ansibleでは、承認したときと同じ差分が適用されることを、ツールの仕組みとして保証できません。パイプラインで保証できるのは、承認したときと同じコミットのPlaybookを実行することまでです。その条件は、**[セクション5](#5-手動起動を承認ゲートにする)** の承認ゲートで扱います。承認の材料に現れない`shell`や`command`のタスクを、レビューの前に機械的に見つける仕組みは、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** でansible-lintをパイプラインに組み込むときに扱います。

なお、`--diff`は、このセクション以降もワークフローに残します。`--diff`は書き込む内容をそのままログに表示するため、テンプレートで機密の値を配置するタスクでは、その値がログに出るおそれがあります。この検証環境のPlaybookには該当するタスクはありませんが、機密の値と差分の表示の関係は、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** で扱います。

### ■ 検証内容：確認用のタスクとファイルの削除

タスクを消しても、書き込まれたファイルは操作対象に残ります。そのため、後片付けは2つのプルリクエストに分けました。1つ目で、タスクを2つのファイルを削除する内容に置き換え、2つ目で、タスクファイルと、それを読み込む`main.yml`の2行を外します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline -1
git switch -c gitops07-check-diff-cleanup1
cat > ansible/roles/common_setup/tasks/gitops07_review.yml <<'EOF'
---
- name: 承認の確認用の設定ファイルを削除
  become: true
  ansible.builtin.file:
    path: "{{ item }}"
    state: absent
  loop:
    - /etc/gitops07-copy.conf
    - /etc/gitops07-shell.conf
EOF
git --no-pager diff
git add ansible/roles/common_setup/tasks/gitops07_review.yml
git commit -m "GitOps第7回: 確認用の設定ファイルを削除するタスクに置き換える"
git push -u origin gitops07-check-diff-cleanup1
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
（途中省略：オブジェクトの受信の表示）
From https://github.com/juehara-crypto/ansible-terraform-ci-lab
   a474aa5..b13d7be  main       -> origin/main
Updating a474aa5..b13d7be
Fast-forward
 .github/workflows/gitops-pipeline.yml                |  4 ++--
 ansible/roles/common_setup/tasks/gitops07_review.yml | 11 +++++++++++
 ansible/roles/common_setup/tasks/main.yml            |  2 ++
 3 files changed, 15 insertions(+), 2 deletions(-)
 create mode 100644 ansible/roles/common_setup/tasks/gitops07_review.yml
b13d7be (HEAD -> main, origin/main) Merge pull request #30 from juehara-crypto/gitops07-check-diff
Switched to a new branch 'gitops07-check-diff-cleanup1'
diff --git a/ansible/roles/common_setup/tasks/gitops07_review.yml b/ansible/roles/common_setup/tasks/gitops07_review.yml
index a441b15..078c417 100644
--- a/ansible/roles/common_setup/tasks/gitops07_review.yml
+++ b/ansible/roles/common_setup/tasks/gitops07_review.yml
@@ -1,11 +1,9 @@
 ---
-- name: 承認の確認用の設定ファイルを配置（copy）
+- name: 承認の確認用の設定ファイルを削除
   become: true
-  ansible.builtin.copy:
-    dest: /etc/gitops07-copy.conf
-    content: "written_by=copy\n"
-    mode: "0644"
-
-- name: 承認の確認用の設定ファイルを書き出す（shell）
-  become: true
-  ansible.builtin.shell: echo "written_by=shell" > /etc/gitops07-shell.conf
+  ansible.builtin.file:
+    path: "{{ item }}"
+    state: absent
+  loop:
+    - /etc/gitops07-copy.conf
+    - /etc/gitops07-shell.conf
[gitops07-check-diff-cleanup1 c41b7ce] GitOps第7回: 確認用の設定ファイルを削除するタスクに置き換える
 1 file changed, 7 insertions(+), 9 deletions(-)
（途中省略：プッシュの表示）
```

この変更をプルリクエストにしてマージした後、操作対象を確認しました。

**実行コマンド**

```plaintext
for n in target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n sh -c 'ls -l /etc/gitops07-*'; done
```

**▼ 実行結果**

```plaintext
== target-node1
ls: cannot access '/etc/gitops07-*': No such file or directory
== target-node2
ls: cannot access '/etc/gitops07-*': No such file or directory
== target-node3
ls: cannot access '/etc/gitops07-*': No such file or directory
```

続いて、タスクファイルと読み込みの2行を外すプルリクエスト（`#32`）をマージし（マージコミット`42a6d05`）、手元を更新して、作業用のブランチを削除しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline -1
git branch -d gitops07-check-diff gitops07-check-diff-cleanup1 gitops07-check-diff-cleanup2
git push origin --delete gitops07-check-diff gitops07-check-diff-cleanup1 gitops07-check-diff-cleanup2
git branch -a
git status --short; echo "git_status_exit_code=$?"
grep -n 'ansible-playbook' .github/workflows/gitops-pipeline.yml
cd ansible
ansible-playbook -i dynamic_inventory.py site.yml --check | tail -4
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
（途中省略：オブジェクトの受信の表示）
From https://github.com/juehara-crypto/ansible-terraform-ci-lab
   b8aa754..42a6d05  main       -> origin/main
Updating b8aa754..42a6d05
Fast-forward
 ansible/roles/common_setup/tasks/gitops07_review.yml | 9 ---------
 ansible/roles/common_setup/tasks/main.yml            | 2 --
 2 files changed, 11 deletions(-)
 delete mode 100644 ansible/roles/common_setup/tasks/gitops07_review.yml
42a6d05 (HEAD -> main, origin/main) Merge pull request #32 from juehara-crypto/gitops07-check-diff-cleanup2
Deleted branch gitops07-check-diff (was f384e00).
Deleted branch gitops07-check-diff-cleanup1 (was c41b7ce).
Deleted branch gitops07-check-diff-cleanup2 (was c0bf27d).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops07-check-diff
 - [deleted]         gitops07-check-diff-cleanup1
 - [deleted]         gitops07-check-diff-cleanup2
* main
  remotes/origin/main
git_status_exit_code=0
80:        run: ansible-playbook -i dynamic_inventory.py site.yml --check --diff
117:        run: ansible-playbook -i dynamic_inventory.py site.yml --diff
（途中省略：Pythonのインタープリターに関する警告）
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

確認用のファイルは操作対象から削除され、タスクファイルと読み込みの2行もmainから外れました。ワークフローには、確認系の`--check --diff`と、適用系の`--diff`が残っています。`--check`は3台とも`ok=2`、`changed=0`で、ロールは元の`drift_check.yml`のタスクだけに戻りました。

後片付けを2段階に分けたのは、タスクを消すだけでは、Ansibleが配置したファイルは操作対象から消えないためです。この非対称性は、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** で、`git revert`とロールバックの問題として扱います。

ここまでで、Terraformは保存したplanで「レビューした計画だけを適用し、前提が変わったら止まる」形を作れること、Ansibleは承認の材料が予測にとどまり、材料に現れない変更があることを確認しました。次のセクションでは、この2つを踏まえて、マージから適用系を切り離し、手動の起動を承認とする承認ゲートを組みます。

---

[↑ 目次に戻る](#-目次)

---

## 5. 手動起動を承認ゲートにする

マージから適用系を切り離し、手動で起動するワークフローを承認のゲートにする構成を組んで、実機で確認します。

### 環境の承認の機能は、リポジトリの条件によって使えない

GitHub Actionsには、適用の前に人の承認を挟む標準の機能として、環境（Environments）の「Required reviewers」があります。公式ドキュメント（**[Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)**）では、環境を参照するジョブを、指定した人かチームが承認するまで止めておける機能とされています。開始した本人には承認させない設定もあります。

ただし、同じページでは、GitHub Free、GitHub Pro、GitHub Teamのプランでは、Required reviewersは公開リポジトリでしか使えないとされています。本シリーズのリポジトリは、**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で整理したとおり、self-hostedランナーを使うため非公開で運用しています。この条件では、標準の承認の機能は使えません。

そこで、適用系を、手動で起動するワークフロー（`workflow_dispatch`）に移し、その起動の操作を承認とみなします。公式ドキュメント（**[Manually running a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)**）では、手動の起動にはリポジトリへの書き込み権限が必要とされています。承認できる人の範囲は、リポジトリの権限の設計で決まることになります。

### 承認ゲートの設計

パイプラインの流れを、次のように変えます。

|きっかけ|ワークフロー|実行すること|
|---|---|---|
|プルリクエスト|`gitops-pipeline.yml`|`terraform plan`と`--check --diff`（コードのレビューの材料）|
|mainへのマージ|`gitops-pipeline.yml`|適用はしない。planを保存し、`--check --diff`を実行する（承認の材料）。承認待ちを記録する|
|手動の起動|`gitops-apply.yml`（新規）|入口の確認→保存したplanの適用→Ansibleの本実行|

設計で決めたことは、次のとおりです。

* **保存したplanの置き場所**：ランナーのホストの`~/gitops-pending/`（本人だけが読めるディレクトリ）に置き、ワークフローの成果物（artifact）にはしません。**[セクション3](#3-保存したplanを適用する)** で見たとおり、planファイルにはtfstateの写しが入るため、成果物にすれば、それをGitHubに預けることになります。また、ジョブの作業ディレクトリは、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** で確認したとおり、次の実行のチェックアウトで掃除されるため、その外に置きます
* **承認待ちの記録**：同じディレクトリに、planを作ったコミット（`commit`）、変更されたパスを判定する起点のコミット（`base`）、`terraform`と`ansible`の判定を置きます。承認の前に次のマージが来た場合は、起点を引き継ぎ、planと判定を最新のmainで作り直します。承認を待つ間に重なったマージの変更も、判定から漏れないようにするためです
* **入口の確認**：手動で起動したワークフローの最初のジョブで、次の3つを確かめます
  * 起動したブランチがmainであること
  * 承認待ちのplanを作ったコミットが、今のmainの先頭と同じであること。**[セクション3](#3-保存したplanを適用する)** で見たとおり、保存したplanは設定が変わっただけでは止まらないため、その対策です
  * 起点から先頭までのmainのコミット（第1親をたどったもの）が、すべてプルリクエストのマージであること。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5で、適用の前に移すとした確認です
* **同時実行**：手動の起動のワークフローも、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** の`concurrency`のグループ`gitops-pipeline`（`queue: max`）に入れ、マージのワークフローと重ならないようにします
* **適用の後**：成功したら、承認待ちを削除します。承認待ちを適用せずに破棄する入力も用意します

3つ目の確認には、GitHubのAPIの「List pull requests associated with a commit」を使います。公式ドキュメント（**[REST API endpoints for commits](https://docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit)**）では、そのコミットをリポジトリに入れた、マージ済みのプルリクエストを返すとされ、必要な権限は「Pull requests」の読み取りです。判定では、マージ済み（`merged_at`がある）で、`merge_commit_sha`がそのコミットと一致するプルリクエストがあるかを見ます。

### ■ 検証内容：ワークフローの変更

`gitops-pipeline.yml`から適用系の2つのジョブを外して、planの保存と承認待ちの記録を加え、適用系を新しい`gitops-apply.yml`に移しました。2つのファイルの内容を確認します。最後の`python3`の行は、2つのファイルがYAMLとして読み込めるかを確かめるものです。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git --no-pager diff .github/workflows/gitops-pipeline.yml
cat -n .github/workflows/gitops-apply.yml
python3 -c 'import sys, yaml; [yaml.safe_load(open(f)) for f in sys.argv[1:]]; print("yaml ok")' .github/workflows/gitops-pipeline.yml .github/workflows/gitops-apply.yml
```

**▼ 実行結果**

```plaintext
diff --git a/.github/workflows/gitops-pipeline.yml b/.github/workflows/gitops-pipeline.yml
index a2ecd75..673984f 100644
--- a/.github/workflows/gitops-pipeline.yml
+++ b/.github/workflows/gitops-pipeline.yml
@@ -21,6 +21,7 @@ jobs:
   changes:
     runs-on: [self-hosted, Linux, X64]
     outputs:
+      base: ${{ steps.filter.outputs.base }}
       terraform: ${{ steps.filter.outputs.terraform }}
       ansible: ${{ steps.filter.outputs.ansible }}
     steps:
@@ -30,9 +31,15 @@ jobs:
       - name: Detect changed paths
         id: filter
         env:
+          EVENT_NAME: ${{ github.event_name }}
           BASE_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}
           HEAD_SHA: ${{ github.sha }}
         run: |
+          if [ "$EVENT_NAME" = "push" ] && [ -f "$HOME/gitops-pending/base" ]; then
+            BASE_SHA=$(cat "$HOME/gitops-pending/base")
+            echo "pending base: $BASE_SHA"
+          fi
+          echo "base=$BASE_SHA" >> "$GITHUB_OUTPUT"
           git diff --name-only "$BASE_SHA" "$HEAD_SHA" | tee "$RUNNER_TEMP/changed_files.txt"
           if grep -q '^terraform/' "$RUNNER_TEMP/changed_files.txt"; then
             echo "terraform=true" >> "$GITHUB_OUTPUT"
@@ -48,7 +55,7 @@ jobs:

   terraform-plan:
     needs: changes
-    if: github.event_name == 'pull_request' && needs.changes.outputs.terraform == 'true'
+    if: needs.changes.outputs.terraform == 'true'
     runs-on: [self-hosted, Linux, X64]
     steps:
       - uses: actions/checkout@v4
@@ -57,11 +64,20 @@ jobs:
         run: terraform init -input=false -lockfile=readonly
       - name: Terraform plan
         working-directory: terraform
-        run: terraform plan -input=false
+        env:
+          EVENT_NAME: ${{ github.event_name }}
+        run: |
+          if [ "$EVENT_NAME" = "push" ]; then
+            mkdir -p -m 700 "$HOME/gitops-pending"
+            umask 077
+            terraform plan -input=false -out="$HOME/gitops-pending/tfplan"
+          else
+            terraform plan -input=false
+          fi

   ansible-check:
     needs: [changes, terraform-plan]
-    if: ${{ !cancelled() && github.event_name == 'pull_request' && needs.terraform-plan.result != 'failure' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true') }}
+    if: ${{ !cancelled() && needs.terraform-plan.result != 'failure' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true') }}
     runs-on: [self-hosted, Linux, X64]
     steps:
       - uses: actions/checkout@v4
@@ -83,39 +99,27 @@ jobs:
         working-directory: ansible
         run: rm -f id_ed25519_generated

-  terraform-apply:
-    needs: changes
-    if: github.event_name == 'push' && needs.changes.outputs.terraform == 'true'
-    runs-on: [self-hosted, Linux, X64]
-    steps:
-      - uses: actions/checkout@v4
-      - name: Terraform init
-        working-directory: terraform
-        run: terraform init -input=false -lockfile=readonly
-      - name: Terraform apply
-        working-directory: terraform
-        run: terraform apply -input=false -auto-approve
-
-  ansible-apply:
-    needs: [changes, terraform-apply]
-    if: ${{ !cancelled() && github.event_name == 'push' && needs.terraform-apply.result != 'failure' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true') }}
+  record-pending:
+    needs: [changes, terraform-plan, ansible-check]
+    if: ${{ !cancelled() && github.event_name == 'push' && needs.terraform-plan.result != 'failure' && needs.ansible-check.result != 'failure' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true') }}
     runs-on: [self-hosted, Linux, X64]
     steps:
-      - uses: actions/checkout@v4
-      - name: Add Ansible to PATH
-        run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
-      - name: Terraform init
-        working-directory: terraform
-        run: terraform init -input=false -lockfile=readonly
-      - name: Write private key from tfstate
-        working-directory: ansible
+      - name: Record pending approval
+        env:
+          BASE_SHA: ${{ needs.changes.outputs.base }}
+          HEAD_SHA: ${{ github.sha }}
+          TF_CHANGED: ${{ needs.changes.outputs.terraform }}
+          ANSIBLE_CHANGED: ${{ needs.changes.outputs.ansible }}
         run: |
+          mkdir -p -m 700 "$HOME/gitops-pending"
+          cd "$HOME/gitops-pending"
           umask 077
-          terraform -chdir=../terraform output -raw generated_private_key > id_ed25519_generated
-      - name: Ansible playbook
-        working-directory: ansible
-        run: ansible-playbook -i dynamic_inventory.py site.yml --diff
-      - name: Remove private key
-        if: always()
-        working-directory: ansible
-        run: rm -f id_ed25519_generated
+          if [ "$TF_CHANGED" != "true" ]; then
+            rm -f tfplan
+          fi
+          echo "$BASE_SHA" > base
+          echo "$HEAD_SHA" > commit
+          echo "$TF_CHANGED" > terraform
+          echo "$ANSIBLE_CHANGED" > ansible
+          ls -l
+          for f in base commit terraform ansible; do echo "$f=$(cat "$f")"; done
     1  name: GitOps Apply
     2
     3  on:
     4    workflow_dispatch:
     5      inputs:
     6        discard_pending:
     7          description: '承認待ちを適用せずに破棄する'
     8          type: boolean
     9          default: false
    10
    11  concurrency:
    12    group: gitops-pipeline
    13    queue: max
    14
    15  permissions:
    16    contents: read
    17    pull-requests: read
    18
    19  env:
    20    TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
    21    TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
    22    PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
    23
    24  jobs:
    25    discard:
    26      if: ${{ inputs.discard_pending }}
    27      runs-on: [self-hosted, Linux, X64]
    28      steps:
    29        - name: Check branch
    30          run: |
    31            echo "ref=$GITHUB_REF sha=$GITHUB_SHA"
    32            if [ "$GITHUB_REF" != "refs/heads/main" ]; then
    33              echo "::error::not started from main"
    34              exit 1
    35            fi
    36        - name: Discard pending approval
    37          run: |
    38            if [ -d "$HOME/gitops-pending" ]; then
    39              cd "$HOME/gitops-pending"
    40              for f in base commit terraform ansible; do [ -f "$f" ] && echo "$f=$(cat "$f")"; done
    41              cd "$HOME"
    42              rm -rf "$HOME/gitops-pending"
    43            fi
    44            echo "pending approval discarded"
    45
    46    verify:
    47      if: ${{ !inputs.discard_pending }}
    48      runs-on: [self-hosted, Linux, X64]
    49      outputs:
    50        terraform: ${{ steps.pending.outputs.terraform }}
    51        ansible: ${{ steps.pending.outputs.ansible }}
    52      steps:
    53        - name: Check branch
    54          run: |
    55            echo "ref=$GITHUB_REF sha=$GITHUB_SHA"
    56            if [ "$GITHUB_REF" != "refs/heads/main" ]; then
    57              echo "::error::not started from main"
    58              exit 1
    59            fi
    60        - uses: actions/checkout@v4
    61          with:
    62            fetch-depth: 0
    63        - name: Read pending approval
    64          id: pending
    65          run: |
    66            if [ ! -f "$HOME/gitops-pending/commit" ]; then
    67              echo "::error::no pending approval"
    68              exit 1
    69            fi
    70            cd "$HOME/gitops-pending"
    71            ls -l
    72            for f in base commit terraform ansible; do echo "$f=$(cat "$f")"; echo "$f=$(cat "$f")" >> "$GITHUB_OUTPUT"; done
    73            if [ "$(cat commit)" != "$GITHUB_SHA" ]; then
    74              echo "::error::pending plan was made from $(cat commit), but main is $GITHUB_SHA"
    75              exit 1
    76            fi
    77        - name: Check commits came from pull requests
    78          env:
    79            GH_TOKEN: ${{ github.token }}
    80            BASE_SHA: ${{ steps.pending.outputs.base }}
    81          run: |
    82            ng=0
    83            for c in $(git rev-list --first-parent "$BASE_SHA..$GITHUB_SHA"); do
    84              pr=$(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
    85                "https://api.github.com/repos/$GITHUB_REPOSITORY/commits/$c/pulls" \
    86                | jq -r --arg c "$c" '[.[] | select(.merged_at != null and .merge_commit_sha == $c) | .number] | first // empty')
    87              if [ -n "$pr" ]; then
    88                echo "$c: merge of pull request #$pr"
    89              else
    90                echo "::error::$c is not a merge of a pull request"
    91                ng=1
    92              fi
    93            done
    94            exit $ng
    95
    96    terraform-apply:
    97      needs: verify
    98      if: needs.verify.outputs.terraform == 'true'
    99      runs-on: [self-hosted, Linux, X64]
   100      steps:
   101        - uses: actions/checkout@v4
   102        - name: Terraform init
   103          working-directory: terraform
   104          run: terraform init -input=false -lockfile=readonly
   105        - name: Terraform apply (saved plan)
   106          working-directory: terraform
   107          run: terraform apply -input=false "$HOME/gitops-pending/tfplan"
   108
   109    ansible-apply:
   110      needs: [verify, terraform-apply]
   111      if: ${{ !cancelled() && needs.verify.result == 'success' && needs.terraform-apply.result != 'failure' && (needs.verify.outputs.terraform == 'true' || needs.verify.outputs.ansible == 'true') }}
   112      runs-on: [self-hosted, Linux, X64]
   113      steps:
   114        - uses: actions/checkout@v4
   115        - name: Add Ansible to PATH
   116          run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
   117        - name: Terraform init
   118          working-directory: terraform
   119          run: terraform init -input=false -lockfile=readonly
   120        - name: Write private key from tfstate
   121          working-directory: ansible
   122          run: |
   123            umask 077
   124            terraform -chdir=../terraform output -raw generated_private_key > id_ed25519_generated
   125        - name: Ansible playbook
   126          working-directory: ansible
   127          run: ansible-playbook -i dynamic_inventory.py site.yml --diff
   128        - name: Remove private key
   129          if: always()
   130          working-directory: ansible
   131          run: rm -f id_ed25519_generated
   132
   133    clear-pending:
   134      needs: [verify, terraform-apply, ansible-apply]
   135      if: ${{ !cancelled() && needs.verify.result == 'success' && needs.terraform-apply.result != 'failure' && needs.ansible-apply.result != 'failure' }}
   136      runs-on: [self-hosted, Linux, X64]
   137      steps:
   138        - name: Clear pending approval
   139          run: |
   140            rm -rf "$HOME/gitops-pending"
   141            echo "pending approval cleared"
yaml ok
```

`gitops-pipeline.yml`は、`terraform-plan`と`ansible-check`の条件から`github.event_name == 'pull_request'`を外し、マージでも動くようにしました。マージ（`push`）のときだけ、planを`~/gitops-pending/tfplan`に保存し、最後の`record-pending`で承認待ちを記録します。`changes`は、承認待ちが残っていれば、その起点から判定します。

`gitops-apply.yml`の`verify`ジョブが、入口の確認です。適用系の`terraform-apply`は、`-auto-approve`ではなく、保存したplanを渡して適用します。`ansible-apply`がチェックアウトするのは、起動の時点のmainの先頭で、`verify`で承認待ちのplanを作ったコミットと同じであることを確かめたコミットです。Ansibleについては、**[セクション4](#4-ansibleの確認モードはplanではない)** で整理したとおり、同じ差分の適用は保証できませんが、承認の材料を作ったときと同じコミットのPlaybookを実行することは、この確認で保証されます。

この変更をプルリクエスト（`#33`）にしてマージしました（マージコミット`03da48d`）。ワークフローのファイルだけの変更なので、承認待ちは作られていません。公式ドキュメントのとおり、`workflow_dispatch`のワークフローは、デフォルトブランチに入った後に手動で起動できるようになります。

### ■ 検証内容：マージでは適用されず、承認待ちが作られる

何も作らない`terraform_data`を加えるプルリクエストで確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops07-gate-v1
cat > terraform/gitops07_gate.tf <<'EOF'
resource "terraform_data" "gitops07_gate" {
  input = "v1"
}
EOF
git status --short
cd terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform plan
cd ..
git add terraform/gitops07_gate.tf
git commit -m "GitOps第7回: 承認ゲートの確認用のterraform_dataを追加"
git push -u origin gitops07-gate-v1
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops07-gate-v1'
?? terraform/gitops07_gate.tf
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # terraform_data.gitops07_gate will be created
  + resource "terraform_data" "gitops07_gate" {
      + id     = (known after apply)
      + input  = "v1"
      + output = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.

（途中省略：区切り線と-outオプションに関する注意書き、コミットとプッシュの表示）
```

このブランチからプルリクエスト（`#34`）を作成し、確認の実行（「GitOps Pipeline」の`#60`）が成功した後に、マージしました（マージコミット`63a8c3b`）。次の画像は、このマージで起動した「GitOps Pipeline」の実行`#61`です。ジョブは`changes`、`terraform-plan`、`ansible-check`、`record-pending`の4つで、適用系のジョブはありません。

![プルリクエスト#34のマージで起動したGitOps Pipelineの実行#61。changes、terraform-plan、ansible-check、record-pendingが成功し、適用系のジョブはない](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/section5-merge-pending-run.png)

**▼ 実行結果（`#34`のマージの実行`#61`、`terraform-plan`ジョブのステップ「Terraform plan」から抜粋）**

```plaintext
Run if [ "$EVENT_NAME" = "push" ]; then
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # terraform_data.gitops07_gate will be created
  + resource "terraform_data" "gitops07_gate" {
      + id     = (known after apply)
      + input  = "v1"
      + output = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.

（途中省略：区切り線）

Saved the plan to: /home/control/gitops-pending/tfplan

To perform exactly these actions, run the following command to apply:
    terraform apply "/home/control/gitops-pending/tfplan"
```

マージの実行が終わった後に、ランナーのホストの承認待ちと、tfstateを確認します。

**実行コマンド**

```plaintext
ls -la ~/gitops-pending
cat ~/gitops-pending/base ~/gitops-pending/commit ~/gitops-pending/terraform ~/gitops-pending/ansible
git switch main
git pull
git log --oneline -2
cd terraform
terraform state list | grep gitops07; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
total 40
drwx------  2 control control  4096 Oct  8 08:00 .
drwxr-x--- 13 control control  4096 Oct  8 08:00 ..
-rw-------  1 control control     6 Oct  8 08:00 ansible
-rw-------  1 control control    41 Oct  8 08:00 base
-rw-------  1 control control    41 Oct  8 08:00 commit
-rw-------  1 control control     5 Oct  8 08:00 terraform
-rw-------  1 control control 15158 Oct  8 08:00 tfplan
03da48debeebfcbfd1bc21e72f6b7d940dcfecce
63a8c3b98419541e4339d18e97665f8352ffc64f
true
false
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
（途中省略：オブジェクトの受信の表示）
From https://github.com/juehara-crypto/ansible-terraform-ci-lab
   03da48d..63a8c3b  main       -> origin/main
Updating 03da48d..63a8c3b
Fast-forward
 terraform/gitops07_gate.tf | 3 +++
 1 file changed, 3 insertions(+)
 create mode 100644 terraform/gitops07_gate.tf
63a8c3b (HEAD -> main, origin/main) Merge pull request #34 from juehara-crypto/gitops07-gate-v1
da3cb72 (origin/gitops07-gate-v1, gitops07-gate-v1) GitOps第7回: 承認ゲートの確認用のterraform_dataを追加
exit_code=1
```

承認待ちには、起点`03da48d`（`#33`のマージ）、planを作ったコミット`63a8c3b`（`#34`のマージ）、`terraform`の判定`true`、`ansible`の判定`false`と、保存したplanが記録されました。どれも本人だけが読める権限です。tfstateには`terraform_data.gitops07_gate`がまだなく（`exit_code=1`）、マージしても適用されていません。

承認する人は、この実行`#61`の`terraform-plan`のログ（保存したplanの内容）と、`ansible-check`のログ（`--check --diff`の出力）を見て、適用してよいかを判断します。

### ■ 検証内容：手動の起動で、保存したplanが適用される

「Actions」タブの「GitOps Apply」で「Run workflow」を押すと、起動するブランチと、承認待ちを破棄するかの入力が表示されます。ブランチは「main」、破棄のチェックは外したまま起動します。次の画像は、「GitOps Apply」をまだ一度も実行していない状態で、この入力を開いたところです。

![GitOps ApplyのRun workflowの入力。Use workflow fromがBranch: main、承認待ちを適用せずに破棄するのチェックは外れている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/section5-run-workflow-form.png)

起動した実行は、「GitOps Apply」の`#1`です。実行の番号はワークフローごとに振られるため、以降は「GitOps Pipeline」と「GitOps Apply」の実行を、ワークフローの名前を付けて書き分けます。次の画像は、この実行`#1`です。コミット`63a8c3b`（`main`）に対して手動で起動され、`verify`、`terraform-apply`、`ansible-apply`、`clear-pending`が成功し、`discard`はスキップされています。

![GitOps Applyの実行#1。コミット63a8c3bに対して手動で起動され、verify、terraform-apply、ansible-apply、clear-pendingが成功し、discardはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/section5-dispatch-apply-run.png)

**▼ 実行結果（「GitOps Apply」の実行`#1`、`verify`ジョブのステップ「Check commits came from pull requests」から抜粋）**

```plaintext
Run ng=0
（途中省略：実行したスクリプト、シェル、環境変数の表示）
63a8c3b98419541e4339d18e97665f8352ffc64f: merge of pull request #34
```

**▼ 実行結果（「GitOps Apply」の実行`#1`、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）**

```plaintext
Run terraform apply -input=false "$HOME/gitops-pending/tfplan"
（途中省略：実行したスクリプト、シェル、環境変数の表示）
terraform_data.gitops07_gate: Creating...
terraform_data.gitops07_gate: Creation complete after 1s [id=727fb4dd-2b01-c161-8fa9-55e35cee2626]

Apply complete! Resources: 1 added, 0 changed, 0 destroyed.

（途中省略：Outputsの表示）
```

**▼ 実行結果（「GitOps Apply」の実行`#1`、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

**▼ 実行結果（「GitOps Apply」の実行`#1`、`clear-pending`ジョブのステップ「Clear pending approval」から抜粋）**

```plaintext
Run rm -rf "$HOME/gitops-pending"
（途中省略：実行したスクリプト、シェル、環境変数の表示）
pending approval cleared
```

**実行コマンド**

```plaintext
ls -la ~/gitops-pending; echo "exit_code=$?"
terraform state show terraform_data.gitops07_gate
```

**▼ 実行結果**

```plaintext
ls: cannot access '/home/control/gitops-pending': No such file or directory
exit_code=2
# terraform_data.gitops07_gate:
resource "terraform_data" "gitops07_gate" {
    id     = "727fb4dd-2b01-c161-8fa9-55e35cee2626"
    input  = "v1"
    output = "v1"
}
```

`verify`は、承認待ちの範囲のコミット`63a8c3b`を、プルリクエスト`#34`のマージと判定しました。`terraform-apply`は、保存したplanを、`Refreshing state...`の行も出さずにそのまま適用し、`input = "v1"`のリソースが作られました。`ansible-apply`は、Ansibleの変更がないため3台とも`changed=0`で、`clear-pending`が承認待ちを削除しました。

### ■ 検証内容：承認の前に手元から適用すると、承認しても止まる

承認を待っている間に、障害対応などで手元から先に`terraform apply`を実行した場合を確かめます。まず、値を`"v2"`に変えるプルリクエストを作ります。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops07-gate-v2
sed -i 's/input = "v1"/input = "v2"/' terraform/gitops07_gate.tf
git --no-pager diff
git add terraform/gitops07_gate.tf
git commit -m "GitOps第7回: 承認ゲートの確認用のterraform_dataの値をv2に変更"
git push -u origin gitops07-gate-v2
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops07-gate-v2'
diff --git a/terraform/gitops07_gate.tf b/terraform/gitops07_gate.tf
index 4c74343..f816aba 100644
--- a/terraform/gitops07_gate.tf
+++ b/terraform/gitops07_gate.tf
@@ -1,3 +1,3 @@
 resource "terraform_data" "gitops07_gate" {
-  input = "v1"
+  input = "v2"
 }
[gitops07-gate-v2 59eab01] GitOps第7回: 承認ゲートの確認用のterraform_dataの値をv2に変更
 1 file changed, 1 insertion(+), 1 deletion(-)
（途中省略：プッシュの表示）
```

このブランチからプルリクエスト（`#35`）を作成してマージしました（マージコミット`10b6fde`）。マージで起動した「GitOps Pipeline」の実行`#63`は、次の計画を保存しました。

**▼ 実行結果（`#35`のマージの実行`#63`、`terraform-plan`ジョブのステップ「Terraform plan」から抜粋）**

```plaintext
Run if [ "$EVENT_NAME" = "push" ]; then
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  ~ update in-place

Terraform will perform the following actions:

  # terraform_data.gitops07_gate will be updated in-place
  ~ resource "terraform_data" "gitops07_gate" {
        id     = "727fb4dd-2b01-c161-8fa9-55e35cee2626"
      ~ input  = "v1" -> "v2"
      ~ output = "v1" -> (known after apply)
    }

Plan: 0 to add, 1 to change, 0 to destroy.

（途中省略：区切り線）

Saved the plan to: /home/control/gitops-pending/tfplan

To perform exactly these actions, run the following command to apply:
    terraform apply "/home/control/gitops-pending/tfplan"
```

**実行コマンド**

```plaintext
ls -la ~/gitops-pending
cat ~/gitops-pending/base ~/gitops-pending/commit ~/gitops-pending/terraform ~/gitops-pending/ansible
git switch main
git pull
git log --oneline -2
```

**▼ 実行結果**

```plaintext
total 40
drwx------  2 control control  4096 Oct  8 08:49 .
drwxr-x--- 13 control control  4096 Oct  8 08:47 ..
-rw-------  1 control control     6 Oct  8 08:49 ansible
-rw-------  1 control control    41 Oct  8 08:49 base
-rw-------  1 control control    41 Oct  8 08:49 commit
-rw-------  1 control control     5 Oct  8 08:49 terraform
-rw-------  1 control control 15407 Oct  8 08:47 tfplan
63a8c3b98419541e4339d18e97665f8352ffc64f
10b6fde539726ea98ea658d0e95345a11cad200d
true
false
Already on 'main'
Your branch is up to date with 'origin/main'.
（途中省略：オブジェクトの受信の表示）
From https://github.com/juehara-crypto/ansible-terraform-ci-lab
   63a8c3b..10b6fde  main       -> origin/main
Updating 63a8c3b..10b6fde
Fast-forward
 terraform/gitops07_gate.tf | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
10b6fde (HEAD -> main, origin/main) Merge pull request #35 from juehara-crypto/gitops07-gate-v2
59eab01 (origin/gitops07-gate-v2, gitops07-gate-v2) GitOps第7回: 承認ゲートの確認用のterraform_dataの値をv2に変更
```

前回の承認待ちは適用の後に削除されているため、今回の起点は、プッシュの前のコミット`63a8c3b`です。この状態で、承認の前に、手元から同じ変更を先に適用します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
mkdir -p -m 700 ~/gitops07-local
(umask 077; terraform plan -out=$HOME/gitops07-local/tfplan-local)
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  ~ update in-place

Terraform will perform the following actions:

  # terraform_data.gitops07_gate will be updated in-place
  ~ resource "terraform_data" "gitops07_gate" {
        id     = "727fb4dd-2b01-c161-8fa9-55e35cee2626"
      ~ input  = "v1" -> "v2"
      ~ output = "v1" -> (known after apply)
    }

Plan: 0 to add, 1 to change, 0 to destroy.

（途中省略：区切り線）

Saved the plan to: /home/control/gitops07-local/tfplan-local

To perform exactly these actions, run the following command to apply:
    terraform apply "/home/control/gitops07-local/tfplan-local"
```

**実行コマンド**

```plaintext
terraform apply $HOME/gitops07-local/tfplan-local
rm -r ~/gitops07-local
terraform state show terraform_data.gitops07_gate
ls -la ~/gitops-pending
```

**▼ 実行結果**

```plaintext
terraform_data.gitops07_gate: Modifying... [id=727fb4dd-2b01-c161-8fa9-55e35cee2626]
terraform_data.gitops07_gate: Modifications complete after 0s [id=727fb4dd-2b01-c161-8fa9-55e35cee2626]

Apply complete! Resources: 0 added, 1 changed, 0 destroyed.

（途中省略：Outputsの表示）
# terraform_data.gitops07_gate:
resource "terraform_data" "gitops07_gate" {
    id     = "727fb4dd-2b01-c161-8fa9-55e35cee2626"
    input  = "v2"
    output = "v2"
}
total 40
drwx------  2 control control  4096 Oct  8 08:49 .
drwxr-x--- 13 control control  4096 Oct  8 08:52 ..
-rw-------  1 control control     6 Oct  8 08:49 ansible
-rw-------  1 control control    41 Oct  8 08:49 base
-rw-------  1 control control    41 Oct  8 08:49 commit
-rw-------  1 control control     5 Oct  8 08:49 terraform
-rw-------  1 control control 15407 Oct  8 08:47 tfplan
```

tfstateは`input = "v2"`になり、承認待ちのplanはそのまま残っています。この状態で、「GitOps Apply」を同じ条件（ブランチは「main」、破棄のチェックなし）で起動しました。次の画像は、その実行`#2`です。`verify`は成功し、`terraform-apply`が失敗して、`ansible-apply`と`clear-pending`はスキップされています。

![GitOps Applyの実行#2。コミット10b6fdeに対して手動で起動され、verifyは成功、terraform-applyが失敗し、ansible-applyとclear-pendingはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/section5-stale-run.png)

**▼ 実行結果（「GitOps Apply」の実行`#2`、`verify`ジョブのステップ「Check commits came from pull requests」から抜粋）**

```plaintext
Run ng=0
（途中省略：実行したスクリプト、シェル、環境変数の表示）
10b6fde539726ea98ea658d0e95345a11cad200d: merge of pull request #35
```

**▼ 実行結果（「GitOps Apply」の実行`#2`、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」）**

```plaintext
Run terraform apply -input=false "$HOME/gitops-pending/tfplan"
╷
│ Error: Saved plan is stale
│ 
│ The given plan file can no longer be applied because the state was changed
│ by another operation after the plan was created.
╵
Error: Process completed with exit code 1.
```

**実行コマンド**

```plaintext
ls -la ~/gitops-pending; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
total 40
drwx------  2 control control  4096 Oct  8 08:49 .
drwxr-x--- 13 control control  4096 Oct  8 08:52 ..
-rw-------  1 control control     6 Oct  8 08:49 ansible
-rw-------  1 control control    41 Oct  8 08:49 base
-rw-------  1 control control    41 Oct  8 08:49 commit
-rw-------  1 control control     5 Oct  8 08:49 terraform
-rw-------  1 control control 15407 Oct  8 08:47 tfplan
exit_code=0
```

入口の確認は通りましたが、**[セクション3](#3-保存したplanを適用する)** で手元で確認したのと同じく、承認待ちのplanは`Saved plan is stale`で拒否されました。承認した時点で、レビューしたplanの前提（tfstate）が変わっていたため、適用されずに止まっています。`ansible-apply`も動かず、承認待ちは残りました。

止まった承認待ちは、破棄の入力で片付けます。「GitOps Apply」を、ブランチは「main」、破棄のチェックを入れて起動しました。次の画像は、その実行`#3`です。`discard`だけが成功し、ほかのジョブはスキップされています。

![GitOps Applyの実行#3。承認待ちの破棄として起動され、discardだけが成功し、verify、terraform-apply、ansible-apply、clear-pendingはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/section5-discard-run.png)

**▼ 実行結果（「GitOps Apply」の実行`#3`、`discard`ジョブのステップ「Discard pending approval」から抜粋）**

```plaintext
Run if [ -d "$HOME/gitops-pending" ]; then
（途中省略：実行したスクリプト、シェル、環境変数の表示）
base=63a8c3b98419541e4339d18e97665f8352ffc64f
commit=10b6fde539726ea98ea658d0e95345a11cad200d
terraform=true
（途中省略：ansibleの判定の表示）
pending approval discarded
```

**実行コマンド**

```plaintext
ls -la ~/gitops-pending; echo "exit_code=$?"
terraform plan -detailed-exitcode > /dev/null; echo "plan_exit_code=$?"
```

**▼ 実行結果**

```plaintext
ls: cannot access '/home/control/gitops-pending': No such file or directory
exit_code=2
plan_exit_code=0
```

承認待ちは削除されました。手元から先に適用していたため、mainの内容（`input = "v2"`）はすでにtfstateに入っていて、`terraform plan`は差分なしです。

### ■ 検証内容：mainへの直接プッシュを含むと、入口で止まる

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5で確認したとおり、この検証環境では、mainへの直接プッシュを止められません。プルリクエストを通さずに、Terraformの変更をmainに直接プッシュします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline -1
sed -i 's/input = "v2"/input = "v3"/' terraform/gitops07_gate.tf
git --no-pager diff
git add terraform/gitops07_gate.tf
git commit -m "GitOps第7回: 承認ゲートの確認用のterraform_dataの値をv3に変更（直接プッシュ）"
git push origin main; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
Already on 'main'
Your branch is up to date with 'origin/main'.
Already up to date.
10b6fde (HEAD -> main, origin/main) Merge pull request #35 from juehara-crypto/gitops07-gate-v2
diff --git a/terraform/gitops07_gate.tf b/terraform/gitops07_gate.tf
index f816aba..362782f 100644
--- a/terraform/gitops07_gate.tf
+++ b/terraform/gitops07_gate.tf
@@ -1,3 +1,3 @@
 resource "terraform_data" "gitops07_gate" {
-  input = "v2"
+  input = "v3"
 }
[main b49e9bb] GitOps第7回: 承認ゲートの確認用のterraform_dataの値をv3に変更（直接プッシュ）
 1 file changed, 1 insertion(+), 1 deletion(-)
（途中省略：オブジェクトの送信の表示）
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
   10b6fde..b49e9bb  main -> main
exit_code=0
```

直接プッシュは受け付けられ、このプッシュで起動した「GitOps Pipeline」の実行`#64`も、`terraform-plan`、`ansible-check`、`record-pending`が成功しました。実行が終わった後の承認待ちは、次のとおりです。

**実行コマンド**

```plaintext
ls -la ~/gitops-pending
cat ~/gitops-pending/base ~/gitops-pending/commit ~/gitops-pending/terraform ~/gitops-pending/ansible
```

**▼ 実行結果**

```plaintext
total 40
drwx------  2 control control  4096 Oct  8 09:08 .
drwxr-x--- 13 control control  4096 Oct  8 09:07 ..
-rw-------  1 control control     6 Oct  8 09:08 ansible
-rw-------  1 control control    41 Oct  8 09:08 base
-rw-------  1 control control    41 Oct  8 09:08 commit
-rw-------  1 control control     5 Oct  8 09:08 terraform
-rw-------  1 control control 15409 Oct  8 09:07 tfplan
10b6fde539726ea98ea658d0e95345a11cad200d
b49e9bb15eacd9aee84a5ce726d22fc700634d1b
true
false
```

承認待ちの形は、マージで作られたものと変わりません。この状態で、「GitOps Apply」をブランチ「main」、破棄のチェックなしで起動しました。同じ条件で2回起動したため、実行は`#4`と`#5`の2つになり、どちらも同じ結果でした。次の画像は、そのうちの`#5`です。`verify`が失敗し、ほかのジョブはスキップされています。

![GitOps Applyの実行#5。コミットb49e9bbに対して手動で起動され、verifyが失敗し、terraform-apply、ansible-apply、clear-pending、discardはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/section5-direct-push-run.png)

**▼ 実行結果（「GitOps Apply」の実行`#5`、`verify`ジョブのステップ「Check commits came from pull requests」から抜粋）**

```plaintext
Run ng=0
（途中省略：実行したスクリプト、シェル、環境変数の表示）
Error: b49e9bb15eacd9aee84a5ce726d22fc700634d1b is not a merge of a pull request
Error: Process completed with exit code 1.
```

**実行コマンド**

```plaintext
ls -la ~/gitops-pending; echo "exit_code=$?"
cd ~/iac/docker-lab-ci/terraform
terraform state show terraform_data.gitops07_gate
```

**▼ 実行結果**

```plaintext
total 40
drwx------  2 control control  4096 Oct  8 09:08 .
drwxr-x--- 13 control control  4096 Oct  8 09:07 ..
-rw-------  1 control control     6 Oct  8 09:08 ansible
-rw-------  1 control control    41 Oct  8 09:08 base
-rw-------  1 control control    41 Oct  8 09:08 commit
-rw-------  1 control control     5 Oct  8 09:08 terraform
-rw-------  1 control control 15409 Oct  8 09:07 tfplan
exit_code=0
# terraform_data.gitops07_gate:
resource "terraform_data" "gitops07_gate" {
    id     = "727fb4dd-2b01-c161-8fa9-55e35cee2626"
    input  = "v2"
    output = "v2"
}
```

起点`10b6fde`から先頭までのコミット`b49e9bb`には、マージ済みのプルリクエストが見つからず、入口の確認で止まりました。tfstateは`input = "v2"`のままで、直接プッシュした`input = "v3"`は適用されていません。直接プッシュされたコミットはmainに残りますが、インフラには届きません。

### ■ 検証内容：main以外のブランチからの起動は、入口で止まる

公式ドキュメントのとおり、手動の起動では、起動するブランチを選べます。プルリクエストを作らずに、空のコミットを1つ載せたブランチをプッシュし、そのブランチを選んで起動します。mainとプルリクエスト以外へのプッシュでは、ワークフローは動きません。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops07-dispatch-branch
git commit --allow-empty -m "GitOps第7回: main以外のブランチからの起動の確認用（空のコミット）"
git push -u origin gitops07-dispatch-branch
git log --oneline -2
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops07-dispatch-branch'
[gitops07-dispatch-branch e8eccf5] GitOps第7回: main以外のブランチからの起動の確認用（空のコミット）
（途中省略：プッシュの表示）
e8eccf5 (HEAD -> gitops07-dispatch-branch, origin/gitops07-dispatch-branch) GitOps第7回: main以外のブランチからの起動の確認用（空のコミット）
b49e9bb (origin/main, main) GitOps第7回: 承認ゲートの確認用のterraform_dataの値をv3に変更（直接プッシュ）
```

**実行コマンド**

```plaintext
git switch main
git branch --show-current
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
main
```

「GitOps Apply」の「Run workflow」で、「Use workflow from」に`gitops07-dispatch-branch`を選び、破棄のチェックなしで起動しました。次の画像は、その実行`#6`です。ブランチ`gitops07-dispatch-branch`（コミット`e8eccf5`）に対して起動され、`verify`が失敗しています。

![GitOps Applyの実行#6。ブランチgitops07-dispatch-branchのコミットe8eccf5に対して手動で起動され、verifyが失敗し、ほかのジョブはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/section5-branch-run.png)

**▼ 実行結果（「GitOps Apply」の実行`#6`、`verify`ジョブのステップ「Check branch」から抜粋）**

```plaintext
Run echo "ref=$GITHUB_REF sha=$GITHUB_SHA"
（途中省略：実行したスクリプト、シェル、環境変数の表示）
ref=refs/heads/gitops07-dispatch-branch sha=e8eccf598e0e1ee35ab81e662561d73081535f41
Error: not started from main
Error: Process completed with exit code 1.
```

最初のステップで、mainからの起動ではないとして止まり、承認待ちの読み込みにも進んでいません。

### ■ 検証内容：直接プッシュの承認待ちの破棄と、確認用のリソースの削除

直接プッシュを含む承認待ちは、このままでは、次にプルリクエストをマージしても、起点が引き継がれるため入口で止まり続けます。そこで、破棄の入力で片付けます。「GitOps Apply」を、ブランチ「main」、破棄のチェックを入れて起動しました（実行`#7`）。

**▼ 実行結果（「GitOps Apply」の実行`#7`、`discard`ジョブのステップ「Discard pending approval」から抜粋）**

```plaintext
Run if [ -d "$HOME/gitops-pending" ]; then
（途中省略：実行したスクリプト、シェル、環境変数の表示）
base=10b6fde539726ea98ea658d0e95345a11cad200d
commit=b49e9bb15eacd9aee84a5ce726d22fc700634d1b
terraform=true
（途中省略：ansibleの判定の表示）
pending approval discarded
```

破棄の後の、mainとtfstateの関係を確認します。

**実行コマンド**

```plaintext
ls -la ~/gitops-pending; echo "exit_code=$?"
cd ~/iac/docker-lab-ci/terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform plan
```

**▼ 実行結果**

```plaintext
ls: cannot access '/home/control/gitops-pending': No such file or directory
exit_code=2
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  ~ update in-place

Terraform will perform the following actions:

  # terraform_data.gitops07_gate will be updated in-place
  ~ resource "terraform_data" "gitops07_gate" {
        id     = "727fb4dd-2b01-c161-8fa9-55e35cee2626"
      ~ input  = "v2" -> "v3"
      ~ output = "v2" -> (known after apply)
    }

Plan: 0 to add, 1 to change, 0 to destroy.

（途中省略：区切り線と-outオプションに関する注意書き）
```

承認待ちを破棄しても、直接プッシュした変更はmainに残っています。mainの内容と適用されている内容の差（`"v2" -> "v3"`）は、計画として見える状態のまま残りました。

続いて、確認用のファイルを削除するプルリクエストを作ります。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops07-gate-cleanup
git rm terraform/gitops07_gate.tf
cd terraform
terraform plan
cd ..
git commit -m "GitOps第7回: 承認ゲートの確認用のterraform_dataを削除"
git push -u origin gitops07-gate-cleanup
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops07-gate-cleanup'
rm 'terraform/gitops07_gate.tf'
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  - destroy

Terraform will perform the following actions:

  # terraform_data.gitops07_gate will be destroyed
  # (because terraform_data.gitops07_gate is not in configuration)
  - resource "terraform_data" "gitops07_gate" {
      - id     = "727fb4dd-2b01-c161-8fa9-55e35cee2626" -> null
      - input  = "v2" -> null
      - output = "v2" -> null
    }

Plan: 0 to add, 0 to change, 1 to destroy.

（途中省略：区切り線と-outオプションに関する注意書き、コミットとプッシュの表示）
```

このブランチからプルリクエスト（`#36`）を作成してマージし（マージコミット`d2fe886`）、マージの「GitOps Pipeline」の実行`#66`が終わった後の承認待ちを確認しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git fetch
git log --oneline -1 origin/main
ls -la ~/gitops-pending; echo "exit_code=$?"
cat ~/gitops-pending/base ~/gitops-pending/commit ~/gitops-pending/terraform ~/gitops-pending/ansible
```

**▼ 実行結果**

```plaintext
（途中省略：オブジェクトの受信の表示）
From https://github.com/juehara-crypto/ansible-terraform-ci-lab
   b49e9bb..d2fe886  main       -> origin/main
d2fe886 (origin/main) Merge pull request #36 from juehara-crypto/gitops07-gate-cleanup
total 40
drwx------  2 control control  4096 Oct  8 09:39 .
drwxr-x--- 13 control control  4096 Oct  8 09:42 ..
-rw-------  1 control control     6 Oct  8 09:39 ansible
-rw-------  1 control control    41 Oct  8 09:39 base
-rw-------  1 control control    41 Oct  8 09:39 commit
-rw-------  1 control control     5 Oct  8 09:39 terraform
-rw-------  1 control control 15155 Oct  8 09:38 tfplan
exit_code=0
b49e9bb15eacd9aee84a5ce726d22fc700634d1b
d2fe88666eec95fc285033e90201b100198b3a62
true
false
```

破棄で承認待ちがなくなった後のマージなので、起点はプッシュの前のコミット`b49e9bb`になり、範囲に入るのは`#36`のマージだけです。「GitOps Apply」を、ブランチ「main」、破棄のチェックなしで起動しました（実行`#8`）。`discard`以外のジョブがすべて成功しました。

**▼ 実行結果（「GitOps Apply」の実行`#8`、`verify`ジョブのステップ「Check commits came from pull requests」から抜粋）**

```plaintext
Run ng=0
（途中省略：実行したスクリプト、シェル、環境変数の表示）
d2fe88666eec95fc285033e90201b100198b3a62: merge of pull request #36
```

**▼ 実行結果（「GitOps Apply」の実行`#8`、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）**

```plaintext
Run terraform apply -input=false "$HOME/gitops-pending/tfplan"
（途中省略：実行したスクリプト、シェル、環境変数の表示）
terraform_data.gitops07_gate: Destroying... [id=727fb4dd-2b01-c161-8fa9-55e35cee2626]
terraform_data.gitops07_gate: Destruction complete after 0s

Apply complete! Resources: 0 added, 0 changed, 1 destroyed.

（途中省略：Outputsの表示）
```

最後に、作業用のブランチを削除し、終了時点の状態を確認します。`gitops07-dispatch-branch`はmainにマージしていないため、手元の削除には`-D`を使います。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline -1
git branch -d gitops07-approval-gate gitops07-gate-v1 gitops07-gate-v2 gitops07-gate-cleanup
git branch -D gitops07-dispatch-branch
git push origin --delete gitops07-approval-gate gitops07-gate-v1 gitops07-gate-v2 gitops07-gate-cleanup gitops07-dispatch-branch
git branch -a
git status --short; echo "git_status_exit_code=$?"
ls -la ~/gitops-pending; echo "exit_code=$?"
cd terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform plan -detailed-exitcode > /dev/null; echo "plan_exit_code=$?"
terraform state list | wc -l
cd ../ansible
ansible-playbook -i dynamic_inventory.py site.yml --check | tail -4
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is behind 'origin/main' by 2 commits, and can be fast-forwarded.
  (use "git pull" to update your local branch)

Updating b49e9bb..d2fe886
Fast-forward
 terraform/gitops07_gate.tf | 3 ---
 1 file changed, 3 deletions(-)
 delete mode 100644 terraform/gitops07_gate.tf
d2fe886 (HEAD -> main, origin/main) Merge pull request #36 from juehara-crypto/gitops07-gate-cleanup
Deleted branch gitops07-approval-gate (was 5adc40c).
Deleted branch gitops07-gate-v1 (was da3cb72).
Deleted branch gitops07-gate-v2 (was 59eab01).
Deleted branch gitops07-gate-cleanup (was e5ac22e).
Deleted branch gitops07-dispatch-branch (was e8eccf5).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops07-approval-gate
 - [deleted]         gitops07-dispatch-branch
 - [deleted]         gitops07-gate-cleanup
 - [deleted]         gitops07-gate-v1
 - [deleted]         gitops07-gate-v2
* main
  remotes/origin/main
git_status_exit_code=0
ls: cannot access '/home/control/gitops-pending': No such file or directory
exit_code=2
plan_exit_code=0
10
（途中省略：Pythonのインタープリターに関する警告）
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

確認した場面と、承認ゲートの動きを並べると、次のとおりです。

|場面|止めたところ|結果|
|---|---|---|
|プルリクエストをマージした|マージのワークフローに適用系がない|planの保存と`--check --diff`まで。承認待ちを記録した（「GitOps Pipeline」の`#61`）|
|承認待ちを、mainから手動で起動した|―|保存したplanを適用し、Ansibleを実行して、承認待ちを削除した（「GitOps Apply」の`#1`）|
|承認の前に、手元から先に適用した|`terraform-apply`（`Saved plan is stale`）|保存したplanは適用されず、Ansibleも動かなかった（「GitOps Apply」の`#2`）|
|mainに直接プッシュした|`verify`（プルリクエストのマージではない）|直接プッシュした変更は適用されなかった（「GitOps Apply」の`#5`）|
|main以外のブランチから起動した|`verify`（mainからの起動ではない）|承認待ちの読み込みにも進まなかった（「GitOps Apply」の`#6`）|

マージしただけでは、インフラは変わりませんでした。インフラが変わったのは、mainから手動で起動し、入口の確認を通ったときだけです。そのときに適用されたのは、承認待ちとして保存したplanそのものと、そのplanを作ったコミットのPlaybookでした。レビューした後に前提が変わった場合や、プルリクエストを通っていないコミットが含まれる場合は、適用の前に止まりました。

一方で、この構成にも限界があります。

* **承認できる人**：手動の起動に必要なのはリポジトリへの書き込み権限で、プルリクエストを作れる人と、承認できる人を分けられません。開始した本人に承認させない設定も、環境の「Required reviewers」の機能で、この条件では使えません
* **入口の確認そのもの**：確認はワークフローのファイルに書かれています。main以外のブランチで、そのファイルから確認を外して起動すれば、確認も外れることになります（この経路は、仕組みからの導出で、実機では確認していません）。書き込み権限を持つ人を、インフラを操作してよい人に限るという、**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** の信頼の境界が、最後の前提になります
* **破棄した変更**：破棄した承認待ちの変更は、mainにはあるが適用されていない状態で残ります。この検証でも、直接プッシュした`"v3"`は、確認用のファイルを削除するまで、計画の差分として残っていました。mainの内容と、実際に適用した内容の差を、どう記録して扱うかは、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** で導入する「最後に適用したコミット」の記録と、**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** で扱う未適用の差分の整理につながります
* **チェックの結果**：入口で確かめているのは、プルリクエストを通ったかどうかまでで、そのプルリクエストの確認の実行が成功したかは見ていません。チェックの結果を適用の条件にする仕組みは、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** で扱います

保存したplanは、ランナーのホストの本人だけが読めるディレクトリに置き、成果物としてはGitHubに預けていません。ただし、planファイルにtfstateの写しが入る以上、ホストの上に秘密鍵を含みうるファイルが、承認されるまで残ることになります。この扱いは、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

公開リポジトリや、Required reviewersが使えるプランであれば、`gitops-apply.yml`の適用系のジョブに環境を参照させることで、同じゲートを標準の機能で作れます（この構成は、公式ドキュメントの記述からの説明で、実機では確認していません）。その場合も、保存したplanの適用と、プルリクエストを通ったコミットかの確認は、承認の機能とは別に必要です。承認の機能が確かめるのは、誰が承認したかであって、何を適用するかではないためです。

次のセクションでは、手動の起動を挟んだこの構成が、GitOpsの原則とどう関係するかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 手動起動とGitOpsの原則

手動の起動を挟んだ構成が、**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** で整理したGitOpsの原則とどう関係するかを整理します。

### 代わりに満たしていた目的が、手動の操作に置き換わる

**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション5では、本シリーズのpush型の構成と、GitOpsの4原則の関係を次のように整理しました。

* 原則3（自動的な取得）は、エージェントが自ら取得するという形では満たさない。Gitへの変更（マージ）をきっかけにCIが適用することで、人が実行を指示しなくてもGitの内容が反映される、という目的を代わりに満たす
* 原則4（継続的な収束）は、定期的な検知と収束を自前で作って近づける

**[セクション5](#5-手動起動を承認ゲートにする)** の承認ゲートは、このうち原則3の「代わりに満たしていた目的」を外します。マージしただけではインフラは変わらず、反映には人の起動の操作が必要になりました。人が実行を指示しなくても反映される、という状態ではなくなったということです。

### 外れるのはタイミングで、内容ではない

一方で、「Gitが唯一の真実」という前提は崩れていません。**[セクション5](#5-手動起動を承認ゲートにする)** の検証で確認したとおり、手動の起動で適用されるものには、次の制約がかかっています。

* 適用されるのは、mainのコミットから作って保存したplanだけで、起動したときのmainの先頭が、planを作ったコミットと同じでなければ止まる
* Ansibleが実行するのも、そのコミットのPlaybookである
* 起点から先頭までのコミットに、プルリクエストを通っていないものがあれば止まる
* 起動のときに選べるのは、適用するか、破棄するかだけで、適用する内容を変える入力はない

承認する人が決められるのは、mainに入った内容を「いつ」適用するか、または適用しないかです。「何を」適用するかは、Gitに入った内容から作られたplanで決まっていて、承認の操作でGitの外の内容を持ち込む経路はありません。ゲートが止めているのは、内容ではなくタイミングです。

### 承認されずに残った差分は、ドリフトではない

ゲートを挟むと、mainに入っていても、まだ適用されていない変更が生まれます。**[セクション5](#5-手動起動を承認ゲートにする)** でも、破棄した承認待ちの変更（`input = "v3"`）は、mainには入っているが適用されていない差分として、`terraform plan`に現れ続けました。

この差分は、Gitを経由しない変更で実際の状態がずれたドリフトとは、性質が違います。実際の状態は、承認して適用した内容のとおりで、ずれていません。mainと、最後に適用した内容が違うだけです。この2つを区別しないと、定期的な検知が、承認待ちの変更をドリフトとして扱い、承認の前に収束させてしまうことになります。

そのため、第4部では、「main」「最後に適用したコミット」「実際の状態」の3つを区別し、未適用の差分とドリフトを分けます（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)**）。自動収束の収束先も、mainではなく、承認して最後に適用したコミットに限ります（**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**）。最後に適用したコミットの記録は、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** で導入します。この回の承認待ちの記録（起点とplanを作ったコミット）は、その手前の、承認を待っている1件分だけの記録です。

### 自動化の度合いは、リスクで選ぶ

4原則との関係を、承認ゲートの前後で並べると、次のとおりです。

|原則|ゲートを入れる前（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**）|ゲートを入れた後|
|---|---|---|
|1. 宣言型|コードの書き方で決まる|変わらない|
|2. バージョン管理と不変性|Gitで管理する|変わらない。適用されるのは、mainのコミットから作ったplanだけ|
|3. 自動的な取得|マージをきっかけにCIが適用することで、目的を代わりに満たす|反映に人の起動が必要になり、代わりに満たしていた目的は外れる。適用する内容は、Gitの内容から決まる|
|4. 継続的な収束|満たさない（第4部で近づける）|変わらない。収束先を、承認して最後に適用したコミットに限る必要が加わる|

マージのたびに自動で適用する構成と、承認を挟む構成は、どちらかが正しいというものではありません。自動で適用すれば、Gitの内容は早く反映されますが、**[セクション2](#2-プルリクエストで見たplanが適用されるとは限らない)** のように、誰もレビューしていない内容が適用されることがあります。承認を挟めば、レビューした内容だけが適用されますが、反映は人の操作を待ちます。

どちらを選ぶかは、変更が失敗したときの影響の大きさで決めます。本シリーズの検証環境はコンテナですが、作り直しや削除が実際のサービスの停止につながる環境では、承認を挟む理由が大きくなります。本シリーズは、Terraformだけの変更、Ansibleだけの変更、両方にまたがる変更（**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** の3分類）のどれも、同じ1つのゲートを通す構成にしました。変更の種類によって、自動で適用するものと承認を挟むものを分ける設計もありえますが、その分け方そのものが、どの変更なら承認なしでよいかという判断になります。

次のセクションでは、プルリクエストのレビューと、この承認が、それぞれ何を確かめているのかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. コードのレビューと実行の承認

プルリクエストのレビューと、手動の起動による承認を、別々のチェックポイントとして整理します。

### 2つのチェックポイントは、問いも材料も違う

承認ゲートを入れた後のパイプラインには、人が判断する場所が2つあります。

|項目|コードのレビュー|実行の承認|
|---|---|---|
|場所|プルリクエスト|手動の起動（「GitOps Apply」）|
|問い|このコードの変更は、mainに入れてよいか|この内容を、今、この環境に適用してよいか|
|材料|プルリクエストの確認の実行の、`terraform plan`と`--check --diff`|マージの実行で保存したplanと、`--check --diff`|
|材料の基準|確認の実行が動いた時点のmainにマージした結果と、その時点のtfstate|マージした後のmainの先頭と、その時点のtfstate|
|前提が変わったとき|再実行されず、古い結果のまま表示される（**[セクション2](#2-プルリクエストで見たplanが適用されるとは限らない)**）|保存したplanの適用が止まる（**[セクション3](#3-保存したplanを適用する)**、**[セクション5](#5-手動起動を承認ゲートにする)**）|

コードのレビューで確かめるのは、変更そのものの妥当性です。書いたコードが意図どおりか、他の部分と矛盾しないか、という問いには、プルリクエストの時点の材料で答えられます。

一方、適用してよいかという問いには、プルリクエストの時点の材料では答えられません。**[セクション2](#2-プルリクエストで見たplanが適用されるとは限らない)** で確認したとおり、プルリクエストの確認のplanは、その時点のmainに対して計算されたもので、マージまでの間に別の変更が入っても計算し直されません。2つのプルリクエストが、それぞれのレビューでは正しくても、mainの上で組み合わさった結果を、誰もレビューしていませんでした。

承認ゲートを入れる前のパイプラインでは、コードのレビューが、そのまま適用の判断を兼ねていました。マージすれば適用されるため、プルリクエストの確認の結果が、適用の前に人が見る最後の材料だったからです。承認ゲートを入れたことで、適用の判断は、マージした後のmainから作った材料で行う、別のチェックポイントになりました。

### 確認の実行が動かなくても、適用の材料は作られる

**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** では、プルリクエストの確認の実行が待機中に取り消され、確認が一度も動かないまま、マージされて適用されたプルリクエストが出ました。

承認ゲートを入れた後の構成では、プルリクエストの確認が動かないままマージされても、マージしただけでは適用されません。適用の材料（保存したplanと`--check --diff`）は、マージの実行で、マージした後のmainから作られます。承認する人は、その材料を見てから起動します。コードのレビューの材料が欠けても、実行の承認の材料は欠けない構造です。

ただし、プルリクエストの確認が動いたか、成功したかは、入口の確認でも見ていません。確認の結果を、適用の条件として機械的に確かめる仕組みは、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** で扱います。

### 承認したものだけがインフラに届く

2つのチェックポイントを分けたことで、インフラに届く変更には、次の条件がかかるようになりました。

* Terraformについては、承認する人が見た、保存したplanだけが適用される。承認の後に前提（tfstate）が変われば、適用されずに止まる
* Ansibleについては、承認する人が見た材料を作ったときと同じコミットのPlaybookだけが実行される。ただし、**[セクション4](#4-ansibleの確認モードはplanではない)** で確認したとおり、承認の材料に現れない変更があり、承認したときと同じ差分が適用されることまでは保証されない
* どちらも、mainからの起動で、プルリクエストを通ったコミットだけが対象になる

正確に言うと、**インフラに届くのは、人が見て承認したplanと、そのplanを作ったコミットのPlaybookだけです**。Ansibleの側の保証がTerraformより弱いことは、この構成でも残ります。

次のセクションでは、この承認ゲートの設計が、AWSやGCPのプロバイダーでも変わらないことを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 8. クラウドプロバイダーでもゲートの設計は変わらない

この回で組んだ承認ゲートを、AWSやGCPのプロバイダーに切り替えた場合に、何が変わり、何が変わらないかを整理します。クラウドでの実行は行っていないため、ここでは、この回の構成と、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** までに確認した内容を並べて比べます。

### クラウドでは、ゲートの重要性が上がる

この回の検証では、何も作らない`terraform_data`を使いました。クラウドのプロバイダーでは、planに含まれる操作が、実際のサービスに直接影響します。

* インスタンスの作り直し（`must be replaced`）は、停止を伴う。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション6で整理したとおり、どの属性の変更が作り直しになるかは、プロバイダーと属性によって異なる
* 作り直したインスタンスからは、Ansibleで投入した設定が失われ、Playbookの全タスクを適用し直す必要がある
* セキュリティグループやルートテーブルのようなネットワークの設定の変更は、そのネットワークを使うすべてのインスタンスに影響する

**[セクション2](#2-プルリクエストで見たplanが適用されるとは限らない)** のように、誰もレビューしていない内容が適用されたとき、その内容がこうした操作を含んでいれば、影響はコンテナの検証環境より大きくなります。レビューした内容だけを、承認したときだけ適用する仕組みの必要性は、クラウドのほうが高いと言えます。

### 変わらないもの

プロバイダーを切り替えても、この回で組んだ次のものは変わりません。

|設計|プロバイダーを切り替えたとき|
|---|---|
|マージでは適用せず、planを保存して承認待ちにする（**[セクション5](#5-手動起動を承認ゲートにする)**）|変わらない。GitHub Actionsのワークフローの構成で、プロバイダーに関係しない|
|保存したplanを適用し、前提が変われば止める（**[セクション3](#3-保存したplanを適用する)**）|`-out`と、保存したplanの適用は、Terraformの機能でプロバイダーに関係しない。ただし、tfstateが変わったときに止まる動きは、この回のpgバックエンドでの実測で、S3やGCSのバックエンドでは確認していない|
|入口の確認（mainからの起動、planを作ったコミット、プルリクエストを通ったコミット）（**[セクション5](#5-手動起動を承認ゲートにする)**）|変わらない。GitとGitHubの側の確認|
|Ansibleの`--check --diff`に現れない変更がある（**[セクション4](#4-ansibleの確認モードはplanではない)**）|変わらない。Ansibleの確認モードの仕組みで、操作対象がコンテナでも仮想マシンでも同じ|
|コードのレビューと実行の承認を分ける（**[セクション7](#7-コードのレビューと実行の承認)**）|変わらない|

### 置き場所と認証情報の前提が加わる

一方で、クラウドでは、保存したplanの扱いに、次の前提が加わります。

* **planファイルの中身**：planファイルにはtfstateの写しが入るため（**[セクション3](#3-保存したplanを適用する)**）、クラウドのリソースの属性や、tfstateに記録された機密の値も含まれる。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** で確認したとおり、S3やGCSのバックエンドでも、認証情報を設定ファイルではなく環境変数で渡せば、保存したplanに認証情報は残らないとされている
* **planファイルの置き場所**：この回では、ランナーのホストに置いた。クラウドでランナーを実行のたびに作り直す構成にする場合、ホストに置いたファイルは次の実行まで残らないため、承認待ちの置き場所を別に用意する必要がある。その置き場所は、planファイルが機密を含みうることを前提に選ぶ必要がある（この点は、構成からの導出で、実機では確認していない）
  * **承認の機能**：リポジトリの条件によって、環境の「Required reviewers」が使える場合は、適用系のジョブに環境を参照させることで、承認そのものを標準の機能にできる（実機では確認していない）。保存したplanの適用と入口の確認は、その場合も必要である

プロバイダーを切り替えて変わるのは、planに含まれる操作の重さと、保存したplanをどこに置くかの前提です。マージと適用の間にゲートを置き、保存したplanだけを適用し、前提が変われば止め、プルリクエストを通ったコミットだけを対象にする、という構造は、プロバイダーを問わず同じです。

次のセクションでは、この回で確認した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 9. まとめ

この回で整理した内容を確認します。

* プルリクエストの確認で表示されるplanは、確認の実行が動いた時点のmainにマージした結果と、その時点のtfstateから計算されたもので、mainが先に進んでも再実行されない。一方が変えた値を、もう一方が参照する2つのプルリクエストを順にマージすると、どちらのレビューにも現れなかった`input = "v2"`のリソースが適用されることを実機で確認した
* `terraform plan -out`で保存したplanには、計画を作った時点の設定とtfstateの写しが入り、保存した後に設定を書き換えても、保存した計画のとおりに適用されることを実機で確認した。同じtfstateから作った2つのplanのうち、後から適用したものは`Saved plan is stale`で拒否された。止まるきっかけはtfstateの変化で、設定が変わっただけでは止まらない
* Ansibleの`--check --diff`の出力を承認の材料にすると、`copy`の変更は書き込む内容まで見えるが、`shell`のタスクは`skipping`と表示されるだけで、本実行では`changed`になってファイルが書き込まれることを、パイプラインの中で確認した。`--diff`を付けた本実行のログにも、`shell`のタスクの差分は現れなかった。Ansibleには保存したplanに相当する仕組みがなく、承認したときと同じ差分が適用されることは保証できない
* 環境の「Required reviewers」は、リポジトリの条件によっては使えない。適用系を手動で起動するワークフロー（`workflow_dispatch`）に移し、マージではplanの保存と`--check --diff`までにとどめ、手動の起動を承認とする承認ゲートを組んだ。保存したplanは、ランナーのホストの本人だけが読めるディレクトリに置き、成果物としてはGitHubに預けない構成にした
* 手動の起動の入口で、mainからの起動であること、承認待ちのplanを作ったコミットがmainの先頭と同じであること、起点からのコミットがすべてプルリクエストのマージであることを確かめた。承認の前に手元から先に適用した場合、mainに直接プッシュした場合、main以外のブランチから起動した場合は、いずれも適用の前に止まることを実機で確認した
* 手動の起動を挟むと、マージをきっかけにCIが適用することで代わりに満たしていた、GitOpsの原則3の目的は外れる。一方、適用されるのはmainのコミットから作ったplanだけで、ゲートが止めるのは内容ではなくタイミングであり、「Gitが唯一の真実」は崩れない。承認されずに残った差分はドリフトではなく、未適用の差分として区別する
* プルリクエストのレビューは「このコードの変更をmainに入れてよいか」、手動の起動による承認は「この内容を、今、この環境に適用してよいか」を確かめる、別のチェックポイントである。インフラに届くのは、人が見て承認したplanと、そのplanを作ったコミットのPlaybookだけになった
* クラウドのプロバイダーでは、planに停止を伴う作り直しやネットワークの変更が含まれるため、ゲートの必要性は高くなる。ゲートの設計、保存したplanの適用、`--check`の限界は、プロバイダーを問わず同じで、保存したplanの置き場所と、それが機密を含みうることが前提に加わる

---

[↑ 目次に戻る](#-目次)

---

## 10. 次回予告

本シリーズの **[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** では、tfstateをpgバックエンドに移し、パイプラインの実行を直列化して、適用系のジョブがtfstateを失わず、重ならずに動くようにしました。第7回となる今回は、マージすれば適用されるという流れの間に、承認のゲートを設けました。プルリクエストで確認したplanと、マージの後に適用される内容が食い違うことを実機で確認し、保存したplanを適用すれば、レビューした計画だけが適用され、前提が変われば止まることを確かめました。Ansibleの`--check --diff`には、承認の材料に現れない変更があることも、パイプラインの中で確認しました。そのうえで、適用系を手動の起動に分離し、mainからの起動、planを作ったコミット、プルリクエストを通ったコミットを入口で確かめる承認ゲートを組み、手元からの先行した適用、mainへの直接プッシュ、ブランチからの起動のいずれも、適用の前に止まることを実機で確認しました。最後に、ゲートとGitOpsの原則の関係、コードのレビューと実行の承認の違い、クラウドでも設計が変わらないことを整理しました。

この回で、インフラに届くのは、人が見て承認した内容だけになりました。一方、承認する人が見る材料そのものの品質は、まだ人の目に頼っています。入口の確認で確かめているのは、プルリクエストを通ったかどうかまでで、そのプルリクエストの確認が成功したかは見ていません。`shell`のタスクのように、承認の材料に現れない変更も、レビューの前に機械的に見つける仕組みはありません。

  **[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** では、人の承認の手前で品質を機械的に確かめるガードレールとして、ansible-lintとMoleculeをパイプラインに組み込みます。 **[「AnsibleのPlaybookが壊れる理由はテスト文化にあった」](https://qiita.com/juehara-crypto/items/194d5730466aef04ed44)**（以下、Moleculeシリーズ）で作った、変更のたびに確認し続ける仕組みを、確認の結果をインフラに届くための条件にする段階へ進め、適用の前にチェックの結果を確かめる構成と、その限界を示します。

**[次回：第8回：GitOpsの品質ガードレールとしてMoleculeとansible-lintを組み込む](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)　｜　[次の記事：【GitOps編】第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第2部まとめブログ：GitOpsパイプラインで「見たものだけが、承認したときだけ届く」仕組みを積み上げる** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 11. 連載一覧：「Ansible×TerraformをGitOpsで回す」

### 第1部：GitOpsの基本概念とAnsibleとの接続

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)**|なぜ「Gitがインフラの唯一の真実」なのか|GitOpsの4原則を評価軸として、AnsibleとTerraformの充足度を整理する。push型構成の立ち位置と、「唯一の真実」が崩れる3つの経路を示す。|
|**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)**|AnsibleとTerraformのGitOps上での責務分担|責務分担を「変更の種類ごとに必要な実行」として捉え直す。変更の3分類、境界が曖昧な設定の判定基準、Gitの外にある接続面を整理する。|
|**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)**|GitリポジトリとAnsibleの構造設計|変更の分類をパスで表現するディレクトリ構成、Gitに置くもの・置かないもの、モノレポとマルチリポの選択基準、mainを唯一の真実とするブランチ運用を設計する。無料プランの非公開リポジトリでは直接プッシュを防げないため、強制する場所を適用前に移す方針を示す。|
|**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)**|ローカルGitea vs GitHub Actionsの選択基準|到達性・状態の永続性・機密情報の置き場所・運用負荷の4基準で比較し、選択が信頼境界の要件で決まることを示す。本シリーズはGitHub＋self-hostedランナーを採用し、リポジトリを非公開で運用する。第1部の最終回。|

### 第2部：GitHub Actionsによる自動化パイプライン

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**|GitHub ActionsからAnsibleを実行する基本構成|プルリクエストで確認、マージで適用という基本フローを実装する。変更されたパスによるジョブの切り替え、Terraform→Ansibleの実行順序の保証、実行時のインベントリの生成を扱い、AWS・GCPプロバイダーへの書き換え点を示す。第2部の初回。|
|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**|tfstateの管理とパイプラインの同時実行|self-hostedランナー上でtfstateが消える問題と置き場所の設計、連続マージや手動実行との同時実行を扱う。Terraformのstateロックとパイプラインの直列化による二重の保護を設計し、Ansibleにはロックがないという非対称性を示す。|
|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**|planのレビューと承認ゲート|レビューしたplanと実際に適用される内容のずれ、保存したplanの適用、`--check --diff`で承認者に見えない変更を扱う。無料プランの非公開リポジトリでも動く、手動起動による承認ゲートを設計する。「プッシュのたびにインフラが変わる恐怖」への回答となる回。|
|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**|GitOpsの品質ガードレールとしてMoleculeとansible-lintを組み込む|Moleculeシリーズ第4回の「確認し続ける仕組み」の次の段階として、確認結果を「インフラに届くための条件」にする。適用前にチェック結果を確認する構成と、`changed_when: false`によるすり抜けという限界を示す。|
|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**|Terraform側にもガードレールを置く|コードに対する静的チェックと、planに対するポリシーチェックの2層を整理する。planから再生成・削除を検知し、Ansibleの設定消失を適用前に扱う3ツール統合ならではのガードレールを作る。|
|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|複数環境（dev/stg/prod）へのデプロイを分岐させる|環境をブランチではなく、mainの1本と環境別ディレクトリで分ける。tfstate・インベントリ・承認を環境ごとに分け、昇格の順序と条件をワークフローで強制する。「最後に適用したコミット」の記録を導入する。|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**|git revertしてもOSは戻らない：ロールバックの非対称性|宣言型のTerraformはrevertで戻るが、手続き型のAnsibleは入れた設定が残るという非対称性を実機で示す。GitOpsのロールバックをロールフォワードとして整理し、revertの残骸が検知できないことを示す。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**|失敗したパイプラインをどう診断するか|パイプラインの失敗をGitHub Actions・ガードレール・Terraform・Ansibleの4層に分け、「設計どおりの停止か、故障か」を切り分ける。Ansible×Terraformシリーズ第3部の知識を活用する。第2部の最終回。|

---

[↑ 目次に戻る](#-目次)

---