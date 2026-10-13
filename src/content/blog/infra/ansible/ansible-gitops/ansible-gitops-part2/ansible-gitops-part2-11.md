---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第11回：git revertしてもOSは戻らない：ロールバックの非対称性'
description: '適用した変更を`git revert`で取り消したとき、TerraformとAnsibleでインフラの何が戻り、何が戻らないかを、複数環境のパイプラインに通して実機で確かめる。revertで戻るのは、revertの後のコードに元の状態が書かれているものだけであることを示し、戻らないものを戻す方法として、削除を明示する変更を前に進める方法と、作り直す方法を比べる。あわせて、複数環境で削除の変更が一部の環境で飛ばされる問題を確かめる。'
pubDate: 2026-10-13
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'GitHub Actions', 'ロールバック']
seriesId: 'ansible-gitops-part2'
seriesNo: 11
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/'
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
2. [revertの意味はツールで異なる](#2-revertの意味はツールで異なる)
3. [Terraformでもrevertで戻るとは限らない](#3-terraformでもrevertで戻るとは限らない)
4. [Ansibleで追加した変更はrevertで戻らない](#4-ansibleで追加した変更はrevertで戻らない)
5. [Ansibleでも戻るものと戻らないもの](#5-ansibleでも戻るものと戻らないもの)
6. [両方を戻すための2つの設計](#6-両方を戻すための2つの設計)
7. [複数環境でのロールバック](#7-複数環境でのロールバック)
8. [クラウドでは何が同じで何が変わるか](#8-クラウドでは何が同じで何が変わるか)
9. [まとめ](#9-まとめ)
10. [次回予告](#10-次回予告)
11. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#11-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

AnsibleとTerraformのコードをGitで管理し、パイプラインを通して適用していて、

* 適用した変更に、問題が見つかった
* そこで、その変更を`git revert`で取り消すコミットを作り、パイプラインに通して適用した
* よって、インフラは変更する前の状態に戻っている

と考えていないでしょうか。

GitOpsのロールバックを扱う記事の多くは、Kubernetesのマニフェストのように、あるべき状態をすべて宣言として書くツールを前提にしています。そこでは、Gitの履歴を`git revert`で戻し、それを同期すれば、インフラも元に戻ると説明されます。手続き型のAnsibleを含む構成で、revertが何を意味するかまでは、あまり扱われていません。AnsibleとTerraformのパイプラインで、適用した変更をrevertで戻そうとすると、次のような場面にぶつかります。

* revertして適用したのに、入れたパッケージやユーザーが残っている
* 消したはずの設定ファイルが残り、後の変更で予期しない動作をする
* revertしたらコンテナが作り直され、Ansibleで入れた設定がまとめて消えた
* revertしたのに、`terraform plan`に差分が出ず、何も戻らなかった
* どこまで戻ったのかを、パイプラインの結果からは確かめられない

これらは、revertの手順や、戻し忘れの問題に見えます。共通しているのは、revertで戻るのはGitの上のコードであって、インフラの状態ではない点です。そして、コードを戻したときに、インフラのどこが戻り、どこが戻らないかは、それぞれのツールがコードをどう扱うかで決まり、パイプラインの構造としては何も示されていない点です。

Playbookをあるべき状態の宣言として設計する考え方は、**[「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜](https://qiita.com/juehara-crypto/items/d77fa93e82ea4a33ef4f)**（以下、冪等性シリーズ）で扱いました。冪等性シリーズの **[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-10/)** では、「nginxを再起動する」という操作の指示と、「nginxが起動している状態にする」という状態の宣言を比べ、Playbookを読めばシステムのあるべき状態が分かるように、あるべき状態をPlaybookの中で閉じる設計を整理しました。同じ回では、Ansibleが提供するのは冪等性を設計しやすい構造であって、冪等性の自動的な保証ではないと結論づけています。

**[「Ansibleは冪等なのに、なぜサーバは壊れていくのか」](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)**（以下、ドリフトシリーズ）の **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-03/)** では、Ansibleが比べるのはタスクに記述されたあるべき状態だけで、どのタスクにも記述されていないファイルは、cronジョブで書き換えられても、`--check`だけでなく通常の実行でも`changed=0`のまま通過することを確認しました。これらの回は、Playbookを書くときの設計と、Ansibleが実行されていない時間に起きる変化を扱ったもので、Playbookそのものを`git revert`で過去に戻したときに何が起きるかは扱っていません。

また、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）の **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** では、作り直したコンテナからは、Ansibleが入れたファイルとパッケージがどちらも失われ、`terraform apply`はエラーも警告も出さずに完了することを確認しました。

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション4では、Terraformはツールの性質として宣言型である一方、Ansibleはツールの性質としては手続き型で、宣言的に振る舞うかどうかはPlaybookの設計で決まると整理しました。同じ回のセクション6では、Playbookのどのタスクにも書かれていないファイルの手動変更は、Git、Terraform、Ansibleのいずれも検出しないことを確認しています。

第2部では、変更を前に進めるパイプラインを積み上げてきました。その途中で、変更を取り消す場面にも、すでに2回ぶつかっています。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4では、確認用のファイルを配置したタスクを片付けるときに、タスクを消すだけでは配置したファイルが操作対象に残るため、ファイルを削除するタスクに置き換えるプルリクエストと、そのタスクを外すプルリクエストの2段階に分けました。**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** のセクション6では、コンテナに足した環境変数の行を消しても、`terraform plan`に差分が出ず、コンテナは元に戻りませんでした。`env = []`と空であることを明示して、初めて元に戻せています。

**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** では、パイプラインをdev・stg・prodの3つの環境に広げ、1回のマージから3つの承認待ちを作り、環境ごとに「最後に適用したコミット」を記録して、dev、stg、prodの順にしか適用できない形にしました。同じ回の次回予告では、適用した変更が誤りだったときの戻し方と、revertが残したものの検知を、この回に送っています。

第11回となる今回は、適用した変更が誤りだったときに、それを`git revert`で取り消す場面を扱います。まず、revertという操作が、TerraformとAnsibleでそれぞれ何を意味するのかを整理します。次に、Terraformの変更とAnsibleの変更をそれぞれrevertし、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のパイプラインに通して適用したときに、インフラの何が戻り、何が戻らないかを実機で確かめます。そのうえで、両方を戻すための設計として、削除を明示する変更を新しいコミットとして入れる方法と、作り直して組み直す方法を比べます。最後に、複数の環境で戻す変更を扱うときに起きることと、クラウドのプロバイダーでの扱いを整理します。

正確に言うと、**`git revert`が戻すのはGitの上のコードであり、インフラの状態ではありません。インフラが戻るかどうかは、戻したコードが、戻したい状態を宣言しているかどうかで決まります**。この回で扱う問いは、「同じ`git revert`で、なぜ戻るものと戻らないものが分かれるのか。両方を戻すには、何をコミットすればよいのか」です。

次のセクションでは、revertという操作が、TerraformとAnsibleでそれぞれ何を意味するのかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. revertの意味はツールで異なる

`git revert`という同じ操作が、TerraformとAnsibleでそれぞれ何を意味するのかを、これまでの回で確認した事実から整理します。

`git revert`は、指定したコミットの変更を打ち消す、新しいコミットを作ります。Gitの上では、コードが1つ前の内容に戻ります。そのコミットをパイプラインに通して適用したときに、インフラで何が起きるかは、それぞれのツールが、戻ったコードと今のインフラをどう比べるかで決まります。

### Terraformは、コードと記録の差分を計算する

Terraformは、HCLのコード、tfstate、プロバイダーから読み取った実際のリソースの属性を比べて、計画を作ります。tfstateは、Terraformがこれまでに作ったリソースの記録です。

revertでコードが1つ前の内容に戻ると、`terraform plan`は、戻ったコードと、今のtfstateと実際の状態を比べます。変更を適用した後のtfstateには、変更した後の状態が記録されているため、計画は、変更した後の状態から、戻ったコードの状態に向かう変更になります。

* リソースを追加したコミットをrevertした場合：戻ったコードにはリソースがなく、tfstateには記録がある。そのため、計画はリソースの削除になる。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション2で、確認用の`terraform_data`の定義を消したときに、`because terraform_data.gitops07_review is not in configuration`として削除が計画されたのは、この動きです
* 属性の値を変えたコミットをrevertした場合：戻ったコードに書かれた値と、tfstateに記録された今の値が違うため、計画は値を元に戻す変更になる

ただし、Terraformが比べるのは、コードに書かれた属性です。**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** のセクション6では、`docker_container`に足した`env`の行を消しても、計画は`no-op`になり、コンテナに足した環境変数は残りました。`env`は、書かなければプロバイダーが値を決める属性（`optional`と`computed`の両方を持つ属性）で、行を消すことは「空にする」ではなく「何も指定しない」と扱われたためです。行を足したコミットをrevertすることは、行を消すことと同じです。Terraformでも、コードから消したものが、そのまま元に戻るとは限りません。

### Ansibleは、タスクに書かれたものだけを比べる

Ansibleは、Playbookのタスクを順に実行し、タスクごとに、タスクに書かれたあるべき状態と、操作対象の今の状態を比べます。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション4で整理したとおり、Ansibleには、Terraformのtfstateにあたる、適用した結果の記録がありません。比べる相手は、毎回、その時点のPlaybookに書かれたタスクだけです。

revertでPlaybookが1つ前の内容に戻ると、`ansible-playbook`は、戻ったPlaybookのタスクだけを実行します。

* タスクを追加したコミットをrevertした場合：戻ったPlaybookには、そのタスクがない。Ansibleは、そのタスクが入れたものを比べる相手を持たず、何もしない。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4の後片付けで、タスクを消すだけでは配置したファイルが操作対象に残るとして、削除するタスクを先に入れたのは、この動きを避けるためです
* タスクの値を変えたコミットをrevertした場合：戻ったPlaybookにも、そのタスクは残っている。Ansibleは、戻った値をあるべき状態として比べ、違っていれば書き換える

ドリフトシリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-03/)** で確認したとおり、どのタスクにも記述されていないものは、Ansibleの比較の対象になりません。タスクを追加したコミットをrevertすると、そのタスクが入れたものは、この「どのタスクにも記述されていないもの」に移ることになります。

### 違いを分けるのは、適用した結果の記録

2つのツールで、revertの後に起きることを並べると、次のようになります。

```
【Terraform】
revertでコードが戻る
　↓
戻ったコードと、tfstate（これまでに作ったものの記録）を比べる
　↓
コードにないものは削除、値が違うものは元に戻す計画を作る
（ただし、コードに書かれていない属性は比べない）

【Ansible】
revertでPlaybookが戻る
　↓
戻ったPlaybookのタスクだけを、操作対象の今の状態と比べる
　↓
残っているタスクは、戻った値で書き換える
消えたタスクが入れたものは、比べる相手がなく、何もしない
```

|観点|Terraform|Ansible|
|---|---|---|
|あるべき状態の書き方|リソースと属性の宣言|タスクの手順（宣言的に振る舞うかは、モジュールと書き方で決まる）|
|適用した結果の記録|tfstateにある|ない|
|コードから消したもの|リソースごと消したものは、tfstateの記録と比べて削除を計画する。リソースの中で消したブロックや属性は、戻らない場合がある（**[セクション3](#3-terraformでもrevertで戻るとは限らない)**）|比べる相手がなく、何もしない|
|コードの値を戻したもの|コードに書かれた属性は、元の値に戻す計画を作る。書かれていない属性は比べない（**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**）|タスクが残っていれば、戻った値で書き換える|

違いを分けているのは、宣言型か手続き型かという書き方そのものよりも、「何を作ったか」の記録を持っているかどうかです。Terraformは、tfstateに記録があるため、コードから消えたリソースを「作ったが、今はあるべきでないもの」として見つけられます。ただし、この記録が削除の計画につながるのはリソースの単位で、リソースの中のブロックや属性まで同じとは限りません。この点は、次のセクションで実機で確かめます。Ansibleは、記録を持たないため、Playbookから消えたタスクが入れたものを、二度と見つけられません。

第2部では、「Terraformにはあるが、Ansibleにはない」という非対称性に、何度か行き当たってきました。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** のstateロック、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** の保存したplan、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** のplanに対するポリシーチェックは、いずれもTerraformがtfstateとplanを持つことで成り立つ仕組みで、Ansibleには相当するものがありませんでした。revertの扱いの違いも、同じtfstateの有無から生まれています。

ここまでは、これまでの回で確認した事実から組み立てた整理です。このパイプラインで、実際に何が戻り、何が戻らないかは、次のセクションから実機で確かめます。

次のセクションでは、Terraformの変更をrevertし、パイプラインに通して適用したときに、インフラが戻るのかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 3. Terraformでもrevertで戻るとは限らない

Terraformの変更を`git revert`で取り消し、パイプラインに通してdev・stg・prodに適用したときに、インフラが元に戻るかを確かめます。取り消す変更は2種類用意しました。1つは、変更する前のコードに書かれていなかった項目を足した変更、もう1つは、変更する前のコードにも書かれていた値を書き換えた変更です。

### ■ 検証内容：コードになかった項目を足した変更をrevertする

1つ目に取り消すのは、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション5で、昇格の順序を確かめるためにコンテナへ足したラベル（`gitops.promotion-test=replace`）です。このラベルはプルリクエスト#56でmainに入り、マージコミット`f000596`として3環境に適用済みです。ラベルを足すと作り直しになるため、5台はすべてラベル付きで作り直されています。

作業用のブランチで、#56のマージコミットをrevertします。マージコミットなので、`-m 1`を付けてmainの側（第1親）から見た変更を打ち消します。GitHubの画面でプルリクエストを「Revert」したときにできるコミットと同じ形です。

**実行コマンド**

```plaintext
git switch -c gitops11-revert-label
git revert -m 1 --no-edit f000596
git log --oneline -2
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops11-revert-label'
[gitops11-revert-label 7ab76f5] Revert "Merge pull request #56 from juehara-crypto/gitops10-replace-test"
 Date: Mon Oct 12 23:59:31 2026 +0000
 1 file changed, 4 deletions(-)
7ab76f5 (HEAD -> gitops11-revert-label) Revert "Merge pull request #56 from juehara-crypto/gitops10-replace-test"
f000596 (origin/main, main) Merge pull request #56 from juehara-crypto/gitops10-replace-test
```

revertのコミットの差分を確認します。

**実行コマンド**

```plaintext
git --no-pager diff HEAD~1
```

**▼ 実行結果**

```plaintext
diff --git a/terraform/modules/lab_env/main.tf b/terraform/modules/lab_env/main.tf
index 8819340..57961b9 100644
--- a/terraform/modules/lab_env/main.tf
+++ b/terraform/modules/lab_env/main.tf
@@ -35,10 +35,6 @@ resource "tls_private_key" "generated" {
 }

 resource "docker_container" "targets" {
-  labels {
-    label = "gitops.promotion-test"
-    value = "replace"
-  }
   for_each = var.nodes
   name     = each.key
   image    = docker_image.this.image_id
```

revertのコミットは、共通のモジュール（`terraform/modules/lab_env/main.tf`）から`labels`ブロックの4行を消すだけの変更です。このコードで、3環境の計画を手元で確認します。

**実行コマンド**

```plaintext
for e in dev stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e plan -input=false -no-color 2>&1 | grep -E '^  # |forces replacement|^Plan:|No changes'; done
```

**▼ 実行結果**

```plaintext
== dev
No changes. Your infrastructure matches the configuration.
== stg
No changes. Your infrastructure matches the configuration.
== prod
No changes. Your infrastructure matches the configuration.
```

3環境とも`No changes.`でした。ラベルがtfstateと実際のコンテナにどう残っているかを、dev-node1で確認します。

**実行コマンド**

```plaintext
terraform -chdir=terraform/envs/dev state show -no-color 'module.lab_env.docker_container.targets["dev-node1"]' | grep -A 3 -E '^ +labels '
docker inspect dev-node1 --format '{{json .Config.Labels}}'
```

**▼ 実行結果**

```plaintext
    labels {
        label = "gitops.promotion-test"
        value = "replace"
    }
{"gitops.promotion-test":"replace","org.opencontainers.image.version":"22.04"}
```

コードからは`labels`ブロックが消えていますが、tfstateにはラベルの記録が残り、実際のコンテナにもラベルが付いています。それでも、計画は`No changes.`です。

このブランチをプッシュしてプルリクエスト#57を作り、パイプラインに通します。プルリクエストの確認でも、3環境の計画は手元と同じでした。

**▼ 実行結果**（「GitOps Pipeline」の実行#105、`terraform-plan`ジョブのステップ「Terraform plan」から抜粋）

```plaintext
== dev
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.
（途中省略）
== stg
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.
（途中省略）
== prod
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.
```

#57をマージすると（マージコミット`010e1e4`）、3環境の承認待ちが作られました。続けて「GitOps Apply」をdev、stg、prodの順に起動します。devの実行結果は次のとおりです。

**▼ 実行結果**（「GitOps Apply」の実行#36、`verify`ジョブのステップ「Check plan policy」から抜粋）

```plaintext
14448b54412662bb59e5e2909a5b34c839a5f6c4d3ed99115df4496592128187  /home/control/gitops-pending/dev/tfplan
policy: pass
```

**▼ 実行結果**（「GitOps Apply」の実行#36、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）

```plaintext
14448b54412662bb59e5e2909a5b34c839a5f6c4d3ed99115df4496592128187  /home/control/gitops-pending/dev/tfplan

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.
```

**▼ 実行結果**（「GitOps Apply」の実行#36、`record-applied`ジョブのステップ「Record applied commit」から抜粋）

```plaintext
last applied (dev): 010e1e446d6b994544d5bb90ccccff4d5c9f2e0b
```

stg（#37）とprod（#38）でも、入口の確認、`policy: pass`、`Apply complete! Resources: 0 added, 0 changed, 0 destroyed.`、Ansibleの`changed=0`まで同じ結果で、3つの実行はすべて成功しました。prodまで適用し終えたところで、手元の状態を確認します。

**実行コマンド**

```plaintext
ls -la ~/gitops-pending
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do docker inspect -f '{{.Name}} id={{printf "%.12s" .Id}} label={{index .Config.Labels "gitops.promotion-test"}}' "$n"; done
grep -n 'labels' terraform/modules/lab_env/main.tf; echo "grep_exit_code=$?"
for e in dev stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e plan -input=false -detailed-exitcode > /dev/null 2>&1; echo "plan_exit_code=$?"; done
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct 13 01:00 .
drwxr-x--- 14 control control 4096 Oct 13 00:21 ..
 id | env  |                commit_sha
----+------+------------------------------------------
 12 | prod | 010e1e446d6b994544d5bb90ccccff4d5c9f2e0b
 11 | stg  | 010e1e446d6b994544d5bb90ccccff4d5c9f2e0b
 10 | dev  | 010e1e446d6b994544d5bb90ccccff4d5c9f2e0b
(3 rows)

/dev-node1 id=4d0b995fca21 label=replace
/stg-node1 id=bd646c528fca label=replace
/target-node1 id=6cd13161ccca label=replace
/target-node2 id=b033ff754f54 label=replace
/target-node3 id=14fa78b9c5f4 label=replace
grep_exit_code=1
== dev
plan_exit_code=0
== stg
plan_exit_code=0
== prod
plan_exit_code=0
```

### ■ 結果

revertのコミットは、3環境すべてで「最後に適用したコミット」として記録され（`gitops.applied`のid 10〜12）、承認待ちも空になりました。mainのコードに`labels`はなく（`grep_exit_code=1`）、3環境とも`terraform plan`は差分なし（`plan_exit_code=0`）です。それでも、5台のコンテナはIDが変わらず、ラベル`replace`が付いたままでした。

パイプラインの記録、コード、`terraform plan`のどれもが「revertは適用済みで、差分はない」と示しているのに、インフラは元に戻っていません。

### ■ 検証内容：コードにもあった値を書き換えた変更をrevertする

2つ目は、変更する前のコードにも書かれていた値を書き換えた変更です。devの外部ポート（`terraform/envs/dev/main.tf`の`"dev-node1" = 2241`）を`2242`に変えます。ポートの変更は作り直しになりますが、対象はdev-node1の1台だけで、stg・prodのコードは変わりません。

**実行コマンド**

```plaintext
git switch main
git switch -c gitops11-dev-port
sed -i 's/^    "dev-node1" = 2241$/    "dev-node1" = 2242/' terraform/envs/dev/main.tf
git --no-pager diff
```

**▼ 実行結果**

```plaintext
Already on 'main'
Your branch is up to date with 'origin/main'.
Switched to a new branch 'gitops11-dev-port'
diff --git a/terraform/envs/dev/main.tf b/terraform/envs/dev/main.tf
index 9375ae5..6a67f07 100644
--- a/terraform/envs/dev/main.tf
+++ b/terraform/envs/dev/main.tf
@@ -27,7 +27,7 @@ module "lab_env" {
   source = "../../modules/lab_env"

   nodes = {
-    "dev-node1" = 2241
+    "dev-node1" = 2242
   }

   network_name          = "ansible-dev-net"
```

この変更をコミットしてプルリクエスト#58を作ります。プルリクエストの確認で、devの計画は次のようになりました。

**▼ 実行結果**（「GitOps Pipeline」の実行#107、`terraform-plan`ジョブのステップ「Terraform plan」から抜粋）

```plaintext
== dev
（途中省略：Refreshing state...によるリソース一覧の出力）
  # module.lab_env.docker_container.targets["dev-node1"] must be replaced
-/+ resource "docker_container" "targets" {
（途中省略：作り直しに伴う属性の差分）
      ~ labels (known after apply)
      - labels {
          - label = "gitops.promotion-test" -> null
          - value = "replace" -> null
        }

      ~ ports {
          ~ external = 2241 -> 2242 # forces replacement
            # (3 unchanged attributes hidden)
        }

        # (3 unchanged blocks hidden)
    }

Plan: 1 to add, 0 to change, 1 to destroy.
（途中省略：Changes to Outputs）
== stg
（途中省略）
No changes. Your infrastructure matches the configuration.
（途中省略）
== prod
（途中省略）
No changes. Your infrastructure matches the configuration.
```

作り直しの原因はポートの行（`# forces replacement`）です。ここで、1つ目の検証では計画に一度も現れなかったラベルの削除（`- labels {`）が出ています。作り直しになった時点で初めて、作り直す前のコンテナにあったラベルが、新しいコンテナには「ないもの」として計画に現れました。

#58をマージし（マージコミット`462bbe9`）、devに適用します。

**▼ 実行結果**（「GitOps Apply」の実行#39、`verify`ジョブのステップ「Check plan policy」から抜粋）

```plaintext
074961cd3f26c19f7f0e07aa15651bb9567cc384b714af6f0fcaecf5329f436b  /home/control/gitops-pending/dev/tfplan
BLOCK module.lab_env.docker_container.targets["dev-node1"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
Warning: delete or replace is allowed in dev
```

**▼ 実行結果**（「GitOps Apply」の実行#39、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）

```plaintext
074961cd3f26c19f7f0e07aa15651bb9567cc384b714af6f0fcaecf5329f436b  /home/control/gitops-pending/dev/tfplan
module.lab_env.docker_container.targets["dev-node1"]: Destroying... [id=4d0b995fca21346d49de4f1df5137c5b5783bc5e43e613777be81d7ccbfbc077]
（途中省略）
module.lab_env.docker_container.targets["dev-node1"]: Creation complete after 2s [id=2680c9d2f473d500d06f3444a871ee80dff27427ddd075f9070a3bef6fd4c15d]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
```

**▼ 実行結果**（「GitOps Apply」の実行#39、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
（途中省略：Pythonインタプリタに関する警告）
--- before
+++ after: /etc/drift-check-target.conf
@@ -0,0 +1 @@
+monitored_by=***-drift-check

changed: [dev-node1]

TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before
+++ after: /etc/gitops-env.conf
@@ -0,0 +1,2 @@
+env=dev
+promotion=dev-stg-prod

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=3    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

計画の判定（**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**）は作り直しを`BLOCK`と判定し、devなので警告を出して通しました。作り直したdev-node1には、Ansibleが2つのファイルを空の状態から置き直しています（`changed=2`）。

**実行コマンド**

```plaintext
docker inspect dev-node1 --format 'id={{printf "%.12s" .Id}} label={{index .Config.Labels "gitops.promotion-test"}} ports={{json .HostConfig.PortBindings}}'
terraform -chdir=terraform/envs/dev state show -no-color 'module.lab_env.docker_container.targets["dev-node1"]' | grep -A 3 -E '^ +labels '; echo "grep_exit_code=$?"
```

**▼ 実行結果**

```plaintext
id=2680c9d2f473 label=<no value> ports={"22/tcp":[{"HostIp":"0.0.0.0","HostPort":"2242"}]}
grep_exit_code=1
```

dev-node1は外部ポート`2242`で作り直されました。1つ目の検証のrevertでは残ったラベルが、コンテナからもtfstateからも消えています。stg（#40）とprod（#41）は計画が変更なしのため、`policy: pass`、`Apply complete! Resources: 0 added, 0 changed, 0 destroyed.`で適用を終えました。

この変更（#58のマージコミット`462bbe9`）をrevertします。

**実行コマンド**

```plaintext
git switch main
git switch -c gitops11-revert-dev-port
git revert -m 1 --no-edit 462bbe9
git --no-pager diff HEAD~1
for e in dev stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e plan -input=false -no-color 2>&1 | grep -E '^  # |forces replacement|^Plan:|No changes'; done
```

**▼ 実行結果**

```plaintext
Already on 'main'
Your branch is up to date with 'origin/main'.
Switched to a new branch 'gitops11-revert-dev-port'
[gitops11-revert-dev-port 2a70f1a] Revert "Merge pull request #58 from juehara-crypto/gitops11-dev-port"
 Date: Tue Oct 13 01:34:50 2026 +0000
 1 file changed, 1 insertion(+), 1 deletion(-)
diff --git a/terraform/envs/dev/main.tf b/terraform/envs/dev/main.tf
index 6a67f07..9375ae5 100644
--- a/terraform/envs/dev/main.tf
+++ b/terraform/envs/dev/main.tf
@@ -27,7 +27,7 @@ module "lab_env" {
   source = "../../modules/lab_env"

   nodes = {
-    "dev-node1" = 2242
+    "dev-node1" = 2241
   }

   network_name          = "ansible-dev-net"
== dev
  # module.lab_env.docker_container.targets["dev-node1"] must be replaced
          ~ external = 2242 -> 2241 # forces replacement
Plan: 1 to add, 0 to change, 1 to destroy.
== stg
No changes. Your infrastructure matches the configuration.
== prod
No changes. Your infrastructure matches the configuration.
```

今度は、revertの計画に`2242 -> 2241`の差分が現れました。このブランチでプルリクエスト#59を作り、マージして（マージコミット`0a6fa2a`）、devに適用します。

**▼ 実行結果**（「GitOps Apply」の実行#42、`verify`ジョブのステップ「Check plan policy」から抜粋）

```plaintext
1b18c6286bc2717e131c4bccea3a4bc1cf8e9876453b506fc52a2ffed3a70d33  /home/control/gitops-pending/dev/tfplan
BLOCK module.lab_env.docker_container.targets["dev-node1"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
Warning: delete or replace is allowed in dev
```

**▼ 実行結果**（「GitOps Apply」の実行#42、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）

```plaintext
1b18c6286bc2717e131c4bccea3a4bc1cf8e9876453b506fc52a2ffed3a70d33  /home/control/gitops-pending/dev/tfplan
module.lab_env.docker_container.targets["dev-node1"]: Destroying... [id=2680c9d2f473d500d06f3444a871ee80dff27427ddd075f9070a3bef6fd4c15d]
（途中省略）
module.lab_env.docker_container.targets["dev-node1"]: Creation complete after 1s [id=c6fd49c650bdb9a0547ac82da8fa9ff4f0b49cf575382d2f94467c8f591a39d5]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
```

**▼ 実行結果**（「GitOps Apply」の実行#42、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
（途中省略：2つのファイルを置いた差分）
dev-node1                  : ok=3    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

stg（#43）とprod（#44）も、変更なしの適用で終わりました。3環境に適用し終えたところで、手元の状態を確認します。

**実行コマンド**

```plaintext
ls -la ~/gitops-pending
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
docker inspect dev-node1 --format 'id={{printf "%.12s" .Id}} ports={{json .HostConfig.PortBindings}}'
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do docker inspect -f '{{.Name}} id={{printf "%.12s" .Id}} label={{index .Config.Labels "gitops.promotion-test"}}' "$n"; done
for e in dev stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e plan -input=false -detailed-exitcode > /dev/null 2>&1; echo "plan_exit_code=$?"; done
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct 13 01:58 .
drwxr-x--- 14 control control 4096 Oct 13 01:43 ..
 id | env  |                commit_sha
----+------+------------------------------------------
 18 | prod | 0a6fa2a84c16bf16f83e62ace176c5ebb60d0204
 17 | stg  | 0a6fa2a84c16bf16f83e62ace176c5ebb60d0204
 16 | dev  | 0a6fa2a84c16bf16f83e62ace176c5ebb60d0204
(3 rows)

id=c6fd49c650bd ports={"22/tcp":[{"HostIp":"0.0.0.0","HostPort":"2241"}]}
/dev-node1 id=c6fd49c650bd label=<no value>
/stg-node1 id=bd646c528fca label=replace
/target-node1 id=6cd13161ccca label=replace
/target-node2 id=b033ff754f54 label=replace
/target-node3 id=14fa78b9c5f4 label=replace
== dev
plan_exit_code=0
== stg
plan_exit_code=0
== prod
plan_exit_code=0
```

### ■ 結果

devの外部ポートは、revertで`2241`に戻りました。ただし、戻し方は値の書き換えではなく、dev-node1の作り直しでした。変更したときも、revertしたときも、計画の判定は作り直しを`BLOCK`と判定しています。作り直したdev-node1には、パイプラインの`ansible-apply`がPlaybookに書かれた設定を入れ直しました（`changed=2`）。

一方、ラベルは5台のうちdev-node1からだけ消え、stg-node1とtarget-node1〜3には残っています。ラベルが消えたのは、ラベルのrevertを適用したときではなく、ポートの変更でdev-node1が作り直されたときでした。

### 戻るかどうかは、変更する前のコードに書かれていたかで決まる

2つの検証を並べると、次のとおりです。

|revertした変更|変更する前のコード|revertの計画|インフラ|
|---|---|---|---|
|ラベルを足した（#56）|`labels`ブロックがない|3環境とも`No changes.`|ラベルが残った|
|devの外部ポートを`2241`→`2242`に変えた（#58）|`2241`と書かれている|dev-node1の作り直し（`2242 -> 2241`）|ポートが`2241`に戻った|

Terraformは、revertで戻ったコードを、tfstateと実際のリソースに比べて計画を作ります。ポートは変更する前のコードにも値が書かれていたため、Terraformは戻ったコードの`2241`と今の`2242`の違いを見つけました。

ラベルは、変更する前のコードに`labels`ブロックがありませんでした。revertでブロックを消すことは、Terraformにとって「ラベルを空にする」ではなく「ラベルを指定しない」という意味になります。#58の計画には`~ labels (known after apply)`の行がありました。このことから、このプロバイダーでは、コードに書かれていないラベルの値をプロバイダーの側で決める扱いになっていると考えられます。指定しない項目は比べないので、tfstateにラベルの記録が残っていても、計画には現れませんでした。**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** のセクション6で、環境変数（`env`）の行を消しても`no-op`になったのと同じ構造です。

同じラベルでも、足したときは作り直し（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**）、消したときは何も起きませんでした。足すことと消すことが対称にならない現象は、Ansibleだけでなく、Terraformの中でも起きます。ラベルが最終的に消えたのは、作り直しで、今のコードだけから新しいコンテナが作られたからです。作り直しは、コードに書かれていない項目を「比べる」のではなく、「持ち越さない」ことで消します。この性質は、**[セクション6](#6-両方を戻すための2つの設計)** の「作り直して戻す」方法で使います。

### パイプラインの記録は、インフラが戻ったことを示さない

1つ目の検証では、revertのプルリクエストは3環境の入口の確認をすべて通り、`gitops.applied`には3環境とも「最後に適用したコミット」として記録されました。それでもラベルは残っています。

**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** で導入した「最後に適用したコミット」の記録が示すのは、「そのコミットのコードで、適用の処理が成功した」ことです。「インフラがそのコードどおりの状態になった」ことではありません。そして、その差を見つけるはずの`terraform plan`も、コードに書かれていない項目は比べないため、差分なしと答えます。冒頭の「どこまで戻ったのかを、パイプラインの結果からは確かめられない」という場面は、Terraformだけのrevertでも起きます。

### revertで作り直しになる変更は、計画の判定で止まる

ポートのrevertは、変更したときと同じく作り直しになり、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** の計画の判定に`BLOCK`と判定されました。revertは「元に戻す」操作ですが、パイプラインにとっては、ほかの変更と同じく新しいコミットの適用です。作り直しを伴う変更を取り消すと、取り消しのほうも作り直しになります。この検証ではdevだけが対象だったため、警告で通りました。stg・prodで同じことが起きれば、`allow_destroy`を付けて起動し直すまで止まります（この回では検証していません）。

作り直しのたびに、パイプラインの`ansible-apply`がPlaybookに書かれた設定を入れ直しました。**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** のセクション5で確認したとおり、`terraform/`の変更でもAnsibleを全体に実行する構成だからです。ただし、入れ直されるのは「今のPlaybookに書かれたもの」だけです。この違いが、次のセクションで扱うAnsibleのrevertにつながります。

次のセクションでは、Ansibleでユーザーとファイルを追加した変更をrevertし、パイプラインに通して適用したときに、インフラが戻るのかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 4. Ansibleで追加した変更はrevertで戻らない

Ansibleのタスクを足した変更を`git revert`で取り消し、パイプラインに通してdev・stg・prodに適用したときに、タスクが入れたものが操作対象から消えるかを確かめます。

### ■ 検証内容：ユーザーとファイルを追加するタスクを足す

OSに入れるものの例として、ユーザーとファイルを使います。ロール`common_setup`に、ユーザー`gitops11`を作るタスクと、`/etc/gitops11-rollback.conf`を置くタスクを書いたファイルを足し、`tasks/main.yml`から読み込みます。

* **ファイル名：`ansible/roles/common_setup/tasks/rollback_test.yml`（新規作成）**

```yaml
---
- name: ロールバック確認用のユーザーを作成
  become: true
  ansible.builtin.user:
    name: gitops11
    state: present
    create_home: false
- name: ロールバック確認用のファイルを配置
  become: true
  ansible.builtin.copy:
    dest: /etc/gitops11-rollback.conf
    content: "added_by=gitops11\n"
    mode: "0644"
```

* **ファイル名：`ansible/roles/common_setup/tasks/main.yml`（追加した2行）**

```yaml
- name: ロールバック確認のタスクを読み込み
  ansible.builtin.import_tasks: rollback_test.yml
```

ユーザーは`create_home: false`にして、ホームディレクトリを作らないようにしています。残るものを、ユーザーの登録とファイルの2つに絞るためです。

この変更でプルリクエスト#60を作ると、確認の`--check --diff`は次のようになりました。

**▼ 実行結果**（「GitOps Pipeline」の実行#111、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）

```plaintext
== dev
（途中省略：既存の2つのタスクはok）
TASK [common_setup : ロールバック確認用のユーザーを作成] ***********************
changed: [dev-node1]

TASK [common_setup : ロールバック確認用のファイルを配置] ***********************
--- before
+++ after: /etc/gitops11-rollback.conf
@@ -0,0 +1 @@
+added_by=gitops11

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=5    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
（途中省略：stg・prodも同じく、新しい2つのタスクがchanged）
```

ファイルのタスクには`--diff`の差分が出ています。一方、ユーザーのタスクは`changed`と表示されるだけで、何が変わるかの差分は出ていません。`user`モジュールは`--diff`の差分を出さないので、承認する人がプルリクエストで見る材料には、ユーザーが増えることは`changed`の1行としてしか現れません。

#60をマージし（マージコミット`f608761`）、dev、stg、prodの順に適用します。devの実行結果は次のとおりです。

**▼ 実行結果**（「GitOps Apply」の実行#45、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
（途中省略：既存の2つのタスクはok）
TASK [common_setup : ロールバック確認用のユーザーを作成] ***********************
changed: [dev-node1]

TASK [common_setup : ロールバック確認用のファイルを配置] ***********************
--- before
+++ after: /etc/gitops11-rollback.conf
@@ -0,0 +1 @@
+added_by=gitops11

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=5    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

stg（#46）とprod（#47）でも、新しい2つのタスクが`changed`になりました。prodまで適用したところで、手元の状態を確認します。

**実行コマンド**

```plaintext
ls -la ~/gitops-pending
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n sh -c 'getent passwd gitops11; echo "getent_exit_code=$?"; cat /etc/gitops11-rollback.conf 2>&1'; done
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct 13 05:20 .
drwxr-x--- 14 control control 4096 Oct 13 05:08 ..
 id | env  |                commit_sha
----+------+------------------------------------------
 21 | prod | f60876161d3ffb32b1ea3839ad94ea3193c497b6
 20 | stg  | f60876161d3ffb32b1ea3839ad94ea3193c497b6
 19 | dev  | f60876161d3ffb32b1ea3839ad94ea3193c497b6
(3 rows)

== dev-node1
gitops11:x:1001:1001::/home/gitops11:/bin/sh
getent_exit_code=0
added_by=gitops11
（途中省略：stg-node1、target-node1〜3も同じ）
```

5台すべてに、ユーザー`gitops11`とファイルが入りました。

### ■ 検証内容：タスクを足した変更をrevertする

#60のマージコミットをrevertします。

**実行コマンド**

```plaintext
git switch -c gitops11-revert-add
git revert -m 1 --no-edit f608761
git --no-pager diff --stat HEAD~1
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops11-revert-add'
[gitops11-revert-add c28fa07] Revert "Merge pull request #60 from juehara-crypto/gitops11-add-package"
 Date: Tue Oct 13 05:27:07 2026 +0000
 2 files changed, 15 deletions(-)
 delete mode 100644 ansible/roles/common_setup/tasks/rollback_test.yml
 ansible/roles/common_setup/tasks/main.yml          |  2 --
 ansible/roles/common_setup/tasks/rollback_test.yml | 13 -------------
 2 files changed, 15 deletions(-)
```

revertのコミットは、`main.yml`の2行を消し、`rollback_test.yml`をファイルごと消す変更です。このコードで、devに`--check`を実行します。

**実行コマンド**

```plaintext
cd ansible
ansible-playbook -i inventories/dev site.yml --check --diff 2>&1 | sed -n '/^TASK \[common_setup/,$p' | grep -vE '^\[WARNING\]|^interpreter|^https://|^core/'
```

**▼ 実行結果**

```plaintext
TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
ok: [dev-node1]

TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
ok: [dev-node1]

TASK [疎通確認] ****************************************************************
ok: [dev-node1]

PLAY RECAP *********************************************************************
dev-node1                  : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

ユーザーとファイルのタスクは表示されず、`changed=0`です。dev-node1にはユーザーとファイルがあるのに、`--check`には何も現れません。

このブランチでプルリクエスト#61を作ると、確認の`--check --diff`も3環境すべてで同じ結果でした。

**▼ 実行結果**（「GitOps Pipeline」の実行#113、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）

```plaintext
== dev
（途中省略）
dev-node1                  : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== stg
（途中省略）
stg-node1                  : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== prod
（途中省略）
target-node1               : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

#61をマージし（マージコミット`7b390c3`）、dev、stg、prodの順に適用します。devの実行結果は次のとおりです。

**▼ 実行結果**（「GitOps Apply」の実行#48、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
（途中省略：Pythonインタプリタに関する警告）
ok: [dev-node1]

TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
ok: [dev-node1]

TASK [疎通確認] ****************************************************************
ok: [dev-node1]

PLAY RECAP *********************************************************************
dev-node1                  : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**▼ 実行結果**（「GitOps Apply」の実行#48、`record-applied`ジョブのステップ「Record applied commit」から抜粋）

```plaintext
last applied (dev): 7b390c38b00791c5c8d58ccf8ddf7bfc5f784d10
```

stg（#49）とprod（#50）も、`changed=0`で適用を終えました。prodまで適用したところで、手元の状態を確認します。

**実行コマンド**

```plaintext
ls -la ~/gitops-pending
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
grep -rn 'gitops11' ansible/; echo "grep_exit_code=$?"
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n sh -c 'getent passwd gitops11; echo "getent_exit_code=$?"; cat /etc/gitops11-rollback.conf 2>&1'; done
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct 13 05:52 .
drwxr-x--- 14 control control 4096 Oct 13 05:46 ..
 id | env  |                commit_sha
----+------+------------------------------------------
 24 | prod | 7b390c38b00791c5c8d58ccf8ddf7bfc5f784d10
 23 | stg  | 7b390c38b00791c5c8d58ccf8ddf7bfc5f784d10
 22 | dev  | 7b390c38b00791c5c8d58ccf8ddf7bfc5f784d10
(3 rows)

grep_exit_code=1
== dev-node1
gitops11:x:1001:1001::/home/gitops11:/bin/sh
getent_exit_code=0
added_by=gitops11
== stg-node1
gitops11:x:1001:1001::/home/gitops11:/bin/sh
getent_exit_code=0
added_by=gitops11
== target-node1
gitops11:x:1001:1001::/home/gitops11:/bin/sh
getent_exit_code=0
added_by=gitops11
== target-node2
gitops11:x:1001:1001::/home/gitops11:/bin/sh
getent_exit_code=0
added_by=gitops11
== target-node3
gitops11:x:1001:1001::/home/gitops11:/bin/sh
getent_exit_code=0
added_by=gitops11
```

### ■ 結果

revertのコミットは、3環境すべてで「最後に適用したコミット」として記録されました（`gitops.applied`のid 22〜24）。`ansible/`の中に`gitops11`という文字列は1つもなく（`grep_exit_code=1`）、Playbookからユーザーとファイルの記述は消えています。適用は3環境とも`changed=0`で終わりました。

それでも、5台すべてにユーザー`gitops11`とファイル`/etc/gitops11-rollback.conf`が残っています。

### revertしたPlaybookには、消すものが書かれていない

**[セクション2](#2-revertの意味はツールで異なる)** で整理したとおり、Ansibleは、そのときのPlaybookに書かれたタスクだけを、操作対象の今の状態と比べます。revertでタスクがPlaybookから消えると、そのタスクが入れたユーザーとファイルには、比べる相手がなくなります。Ansibleは、消えたタスクについて何もしません。`changed=0`は「何も変わらなかった」という意味ではなく、「Playbookに書かれた範囲に、変える必要があるものはなかった」という意味です。

追加したときは`changed=2`だった変更を取り消したのに、取り消しの適用は`changed=0`です。追加は2つの変更として現れたのに、取り消しは何の変更としても現れていません。

ドリフトシリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-03/)** では、どのタスクにも書かれていないファイルは、cronジョブで書き換えられても`changed=0`のまま通ることを確認しました。revertで残ったユーザーとファイルも、同じ「どのタスクにも書かれていないもの」です。違うのは、外部の何かが作ったものではなく、Playbookが自分で入れて、自分で管理から外したものだという点です。

### 確認の材料にも、適用の記録にも現れない

このrevertは、パイプラインの確認をすべて通りました。

|段階|このrevertでの結果|
|---|---|
|プルリクエストの確認（`--check --diff`）|3環境の5台とも`changed=0`。ユーザーとファイルの行は1つも出ない|
|`ansible-lint`、Molecule|どちらも成功|
|適用（`ansible-apply`）|3環境の5台とも`changed=0`|
|記録（`gitops.applied`）|3環境とも`7b390c3`が「最後に適用したコミット」として記録された|

承認する人が見る材料にも、適用の結果にも、ユーザーとファイルが残ることは現れません。Moleculeが成功したのも、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** のセクション9で整理したとおり、Moleculeが試すのは新しいコンテナにロールを適用したときの収束であり、前回までの適用の結果が残った状態は試さないからです。revertの残りものは、まさにその「前回までの適用の結果」です。

### Terraformのrevertとの違い

**[セクション3](#3-terraformでもrevertで戻るとは限らない)** のラベルも、revertでコードから消えたのに、コンテナに残りました。原因は「コードに書かれていないものは比べない」という同じ構造です。ただし、違いが2つあります。

|観点|Terraform（ラベル）|Ansible（ユーザーとファイル）|
|---|---|---|
|入れたものの記録|tfstateにラベルの記録が残っていた|記録はどこにもない|
|作り直しで消えるか|作り直しで、今のコードだけから新しいコンテナが作られ、消えた|Terraformの変更がないので作り直しは起きず、消えない|

Terraformは、少なくともtfstateに「ラベルが付いている」という記録を持っていました。Ansibleには、そもそも「このユーザーとファイルを入れた」という記録がありません。Playbookから消えた時点で、それが入れたものを知っている仕組みは、パイプラインのどこにもなくなります。

次のセクションでは、Ansibleでも、タスクを消すのではなく、タスクに書いた値を変えた変更なら、revertで戻るのかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 5. Ansibleでも戻るものと戻らないもの

**[セクション4](#4-ansibleで追加した変更はrevertで戻らない)** では、タスクを足した変更をrevertしても、そのタスクが入れたものは残りました。ここでは、タスクを消すのではなく、今あるタスクに書いた値を変えた変更をrevertし、操作対象の値が戻るかを確かめます。

### ■ 検証内容：今あるタスクの値を変える

対象は、ロール`common_setup`にある、環境の名前を書いたファイルを配置するタスクです。このタスクは`ansible.builtin.copy`で、`/etc/gitops-env.conf`の中身を`content`にまるごと書いています。

* **ファイル名：`ansible/roles/common_setup/tasks/environment.yml`（変更前）**

```yaml
---
- name: 環境の名前を書いたファイルを配置
  become: true
  ansible.builtin.copy:
    dest: /etc/gitops-env.conf
    content: "env={{ common_setup_env }}\npromotion=dev-stg-prod\n"
    mode: "0644"
```

変更する前に、5台のファイルの中身と更新日時を確認しておきます。

**実行コマンド**

```plaintext
for c in dev-node1 stg-node1 target-node1 target-node2 target-node3; do
  echo "=== $c ==="
  docker exec "$c" cat /etc/gitops-env.conf
  docker exec "$c" stat -c '%U:%G %a %y' /etc/gitops-env.conf
done
```

**▼ 実行結果**

```plaintext
=== dev-node1 ===
env=dev
promotion=dev-stg-prod
root:root 644 2026-10-13 01:47:10.230535207 +0000
=== stg-node1 ===
env=stg
promotion=dev-stg-prod
root:root 644 2026-10-11 08:58:14.182850331 +0000
=== target-node1 ===
env=prod
promotion=dev-stg-prod
root:root 644 2026-10-11 09:09:41.556229250 +0000
（途中省略：target-node2、target-node3もtarget-node1と同じ中身で、更新日時は2026-10-11 09:09:41〜42）
```

stg-node1とtarget-node1〜3の更新日時は10月11日のままです。**[セクション4](#4-ansibleで追加した変更はrevertで戻らない)** の適用はどれも`changed=0`だったので、このファイルには触れていません。dev-node1だけが今日の日時になっているのは、**[セクション3](#3-terraformでもrevertで戻るとは限らない)** でコンテナが作り直され、その後の適用で新しく置かれたためです。

このタスクの`promotion`の値を`gitops11`に変えます。

**実行コマンド**

```plaintext
git switch -c gitops11-change-value
sed -i 's/promotion=dev-stg-prod/promotion=gitops11/' ansible/roles/common_setup/tasks/environment.yml
git diff
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops11-change-value'
diff --git a/ansible/roles/common_setup/tasks/environment.yml b/ansible/roles/common_setup/tasks/environment.yml
index 43fcfe2..12c79e6 100644
--- a/ansible/roles/common_setup/tasks/environment.yml
+++ b/ansible/roles/common_setup/tasks/environment.yml
@@ -3,5 +3,5 @@
   become: true
   ansible.builtin.copy:
     dest: /etc/gitops-env.conf
-    content: "env={{ common_setup_env }}\npromotion=dev-stg-prod\n"
+    content: "env={{ common_setup_env }}\npromotion=gitops11\n"
     mode: "0644"
```

この変更でプルリクエスト#62を作ると、確認の`--check --diff`は次のようになりました。

**▼ 実行結果**（「GitOps Pipeline」の実行#115、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）

```plaintext
== dev
（途中省略）
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before: /etc/gitops-env.conf
+++ after: /etc/gitops-env.conf
@@ -1,2 +1,2 @@
 env=dev
-promotion=dev-stg-prod
+promotion=gitops11

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
（途中省略：stg-node1、target-node1〜3も同じ1行の差分でchanged=1）
```

#62をマージし（マージコミット`9bacc44`）、dev、stg、prodの順に適用します。devの実行結果は次のとおりです。

**▼ 実行結果**（「GitOps Apply」の実行#51、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before: /etc/gitops-env.conf
+++ after: /etc/gitops-env.conf
@@ -1,2 +1,2 @@
 env=dev
-promotion=dev-stg-prod
+promotion=gitops11

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

stg（#52）とprod（#53）でも、同じ1行の差分で`changed=1`になり、5台すべてのファイルが`promotion=gitops11`になりました。

### ■ 検証内容：値を変えた変更をrevertする

#62のマージコミットをrevertします。

**実行コマンド**

```plaintext
git switch -c gitops11-revert-value
git revert -m 1 --no-edit 9bacc44
cat -n ansible/roles/common_setup/tasks/environment.yml
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops11-revert-value'
[gitops11-revert-value 7b2c3b0] Revert "Merge pull request #62 from juehara-crypto/gitops11-change-value"
 Date: Tue Oct 13 06:42:46 2026 +0000
 1 file changed, 1 insertion(+), 1 deletion(-)
     1  ---
     2  - name: 環境の名前を書いたファイルを配置
     3    become: true
     4    ansible.builtin.copy:
     5      dest: /etc/gitops-env.conf
     6      content: "env={{ common_setup_env }}\npromotion=dev-stg-prod\n"
     7      mode: "0644"
```

**[セクション4](#4-ansibleで追加した変更はrevertで戻らない)** のrevertはタスクをPlaybookから消す変更でしたが、今回のrevertは、タスクを残したまま値を元に戻す変更です。このブランチでプルリクエスト#63を作ると、確認の`--check --diff`は次のようになりました。

**▼ 実行結果**（「GitOps Pipeline」の実行#117、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）

```plaintext
== dev
（途中省略）
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before: /etc/gitops-env.conf
+++ after: /etc/gitops-env.conf
@@ -1,2 +1,2 @@
 env=dev
-promotion=gitops11
+promotion=dev-stg-prod

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
（途中省略：stg-node1、target-node1〜3も同じ1行の差分でchanged=1）
```

#63をマージし（マージコミット`aa5681f`）、dev、stg、prodの順に適用します。devの実行結果は次のとおりです。

**▼ 実行結果**（「GitOps Apply」の実行#54、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before: /etc/gitops-env.conf
+++ after: /etc/gitops-env.conf
@@ -1,2 +1,2 @@
 env=dev
-promotion=gitops11
+promotion=dev-stg-prod

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**▼ 実行結果**（「GitOps Apply」の実行#54、`record-applied`ジョブのステップ「Record applied commit」から抜粋）

```plaintext
last applied (dev): aa5681f9718bf496bf0dd51cb2058431da1485e8
```

stg（#55）とprod（#56）でも、同じ1行の差分で`changed=1`になりました。prodまで適用したところで、5台の状態を確認します。**[セクション4](#4-ansibleで追加した変更はrevertで戻らない)** で残ったユーザーとファイルも、同じループで並べて確認します。

**実行コマンド**

```plaintext
for c in dev-node1 stg-node1 target-node1 target-node2 target-node3; do
  echo "=== $c ==="
  docker exec "$c" cat /etc/gitops-env.conf
  docker exec "$c" stat -c '%U:%G %a %y' /etc/gitops-env.conf
  docker exec "$c" id gitops11
  docker exec "$c" ls -l /etc/gitops11-rollback.conf
done
```

**▼ 実行結果**

```plaintext
=== dev-node1 ===
env=dev
promotion=dev-stg-prod
root:root 644 2026-10-13 07:00:02.434299468 +0000
uid=1001(gitops11) gid=1001(gitops11) groups=1001(gitops11)
-rw-r--r-- 1 root root 18 Oct 13 05:12 /etc/gitops11-rollback.conf
=== stg-node1 ===
env=stg
promotion=dev-stg-prod
root:root 644 2026-10-13 07:04:17.670818090 +0000
uid=1001(gitops11) gid=1001(gitops11) groups=1001(gitops11)
-rw-r--r-- 1 root root 18 Oct 13 05:16 /etc/gitops11-rollback.conf
=== target-node1 ===
env=prod
promotion=dev-stg-prod
root:root 644 2026-10-13 07:05:46.466520786 +0000
uid=1001(gitops11) gid=1001(gitops11) groups=1001(gitops11)
-rw-r--r-- 1 root root 18 Oct 13 05:20 /etc/gitops11-rollback.conf
=== target-node2 ===
env=prod
promotion=dev-stg-prod
root:root 644 2026-10-13 07:05:46.329175233 +0000
uid=1001(gitops11) gid=1001(gitops11) groups=1001(gitops11)
-rw-r--r-- 1 root root 18 Oct 13 05:20 /etc/gitops11-rollback.conf
=== target-node3 ===
env=prod
promotion=dev-stg-prod
root:root 644 2026-10-13 07:05:46.263708591 +0000
uid=1001(gitops11) gid=1001(gitops11) groups=1001(gitops11)
-rw-r--r-- 1 root root 18 Oct 13 05:20 /etc/gitops11-rollback.conf
```

### ■ 結果

5台すべてで、`/etc/gitops-env.conf`の`promotion`が`dev-stg-prod`に戻りました。更新日時は、それぞれの環境のrevertを適用した時刻（dev 07:00、stg 07:04、prod 07:05）です。revertの適用が、実際にファイルを書き戻しています。

同じ5台には、**[セクション4](#4-ansibleで追加した変更はrevertで戻らない)** のユーザー`gitops11`とファイル`/etc/gitops11-rollback.conf`が残ったままです。ファイルの日時は05:12〜05:20のままで、今回の適用では触られていません。

### 戻ったのは、タスクがPlaybookに残っていたから

今回のrevertで値が戻ったのは、revertした後もタスクがPlaybookに残っていて、そのタスクに元の値が書かれていたからです。Ansibleは、Playbookに書かれた`content`とファイルの今の中身を比べ、違っていたので書き戻しました。比べる相手がいたので、戻すことができたわけです。

**[セクション4](#4-ansibleで追加した変更はrevertで戻らない)** との違いを並べます。

|観点|セクション4（タスクを足して消す）|セクション5（タスクの値を変えて戻す）|
|---|---|---|
|revertでPlaybookに起きたこと|タスクがPlaybookから消えた|タスクは残り、値が元に戻った|
|プルリクエストの確認（`--check --diff`）|5台とも`changed=0`。何も出ない|5台とも`changed=1`。戻る1行の差分が出る|
|適用（`ansible-apply`）|5台とも`changed=0`|5台とも`changed=1`|
|操作対象|ユーザーとファイルが残る|ファイルの値が元に戻る|

どちらも同じ`git revert -m 1`で、同じパイプラインを通っています。それでも、「revertの後のPlaybookに、元の状態が書かれているか」によって、結果が分かれました。値を変えた変更では、元の値がタスクの中に書き戻されます。タスクを足した変更では、revertの後のPlaybookに書かれているのは「足す前の状態」ではなく、「そのタスクがない状態」です。Ansibleにとって、タスクがないことは「何もしない」ことであって、「消す」ことではありません。

**[セクション3](#3-terraformでもrevertで戻るとは限らない)** のTerraformでも、同じ形の結果が出ていました。コードに書かれたまま値だけを変えたポートは、revertで戻りました。コードからブロックごと消えたラベルは、revertでは戻りませんでした。ツールが違っても、「revertの後のコードに、元の状態が書かれているか」で結果が分かれる点は共通です。

なお、今回戻ったのは、`copy`がファイルの中身を`content`でまるごと決めているからでもあります。ファイルの一部だけを扱うモジュールでは、元の値に戻すと何が残るかは書き方によって変わります。この回では確かめていません。

### 戻ることが確認の材料に現れる

もう一つの違いは、プルリクエストの段階で見えることです。今回のrevertは、#117の`--check --diff`で、5台それぞれに`-promotion=gitops11`と`+promotion=dev-stg-prod`の差分を出しました。承認する人は、revertで何が戻るのかを、適用する前に1行ずつ確かめられます。

**[セクション4](#4-ansibleで追加した変更はrevertで戻らない)** のrevert（#113）は、`changed=0`で何も出ませんでした。確認の材料に何も出ないので、「戻らないものがある」ことは承認する人には見えません。差分が出ることは「戻ること」の材料になりますが、差分が出ないことは「戻らないものがない」ことの材料にはなりません。

次のセクションでは、ここまでの結果を踏まえて、TerraformとAnsibleの両方で、revertの後に元の状態まで戻すための設計を考えます。

---

[↑ 目次に戻る](#-目次)

---

## 6. 両方を戻すための2つの設計

**[セクション3](#3-terraformでもrevertで戻るとは限らない)** と **[セクション4](#4-ansibleで追加した変更はrevertで戻らない)** で、revertでは戻らないものが残りました。Terraformのラベルと、Ansibleで入れたユーザーとファイルです。ここでは、それらを戻すための設計を2つ試します。

* **設計A：作り直す**　今のコードだけからコンテナを新しく作り、その上に今のPlaybookを当てる
* **設計B：消す変更を書く**　revertでタスクを消すのではなく、「消す」タスクを足して前に進める

始める前に、5台に何が残っているかを確認します。

**実行コマンド**

```plaintext
for c in dev-node1 stg-node1 target-node1 target-node2 target-node3; do
  echo "=== $c ==="
  docker inspect -f '{{.Id}} {{json .Config.Labels}}' "$c"
  docker exec "$c" id gitops11
  docker exec "$c" cat /etc/gitops11-rollback.conf
done
```

**▼ 実行結果**

```plaintext
=== dev-node1 ===
c6fd49c650bdb9a0547ac82da8fa9ff4f0b49cf575382d2f94467c8f591a39d5 {"org.opencontainers.image.version":"22.04"}
uid=1001(gitops11) gid=1001(gitops11) groups=1001(gitops11)
added_by=gitops11
=== stg-node1 ===
bd646c528fcac2e8857e3ddf8e710697d1daffadc41f3283a9d121966d8d630a {"gitops.promotion-test":"replace","org.opencontainers.image.version":"22.04"}
uid=1001(gitops11) gid=1001(gitops11) groups=1001(gitops11)
added_by=gitops11
=== target-node1 ===
6cd13161ccca0c75cad652b8fb9ba42e412d4f8be83be883d6c500a08216440c {"gitops.promotion-test":"replace","org.opencontainers.image.version":"22.04"}
uid=1001(gitops11) gid=1001(gitops11) groups=1001(gitops11)
added_by=gitops11
（途中省略：target-node2、target-node3もtarget-node1と同じく、ラベル・ユーザー・ファイルが残っている）
```

dev-node1にはラベルがありません。**[セクション3](#3-terraformでもrevertで戻るとは限らない)** でコンテナが作り直されたためです。ユーザーとファイルは5台すべてに残っています。

### ■ 検証内容：設計A　devのコンテナを作り直す

このパイプラインには、`terraform apply -replace`のように「作り直しだけ」を指示する入口がありません。用意されているのは、作り直しを含む計画を通すための`allow_destroy`だけです。そのため、GitOpsでコンテナを作り直すには、作り直しが起きるようにコードを変えるしかありません。ここでは、**[セクション3](#3-terraformでもrevertで戻るとは限らない)** と同じく、devの外部ポートを変えます。

**実行コマンド**

```plaintext
git switch -c gitops11-recreate-dev
sed -i 's/"dev-node1" = 2241/"dev-node1" = 2242/' terraform/envs/dev/main.tf
git diff
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops11-recreate-dev'
diff --git a/terraform/envs/dev/main.tf b/terraform/envs/dev/main.tf
index 9375ae5..6a67f07 100644
--- a/terraform/envs/dev/main.tf
+++ b/terraform/envs/dev/main.tf
@@ -27,7 +27,7 @@ module "lab_env" {
   source = "../../modules/lab_env"

   nodes = {
-    "dev-node1" = 2241
+    "dev-node1" = 2242
   }

   network_name          = "ansible-dev-net"
```

この変更でプルリクエスト#64を作ると、確認の材料は次のようになりました。

**▼ 実行結果**（「GitOps Pipeline」の実行#119、`terraform-plan`ジョブのステップ「Terraform plan」から抜粋）

```plaintext
== dev
（途中省略）
  # module.lab_env.docker_container.targets["dev-node1"] must be replaced
-/+ resource "docker_container" "targets" {
（途中省略）
      ~ labels (known after apply)

      ~ ports {
          ~ external = 2241 -> 2242 # forces replacement
            # (3 unchanged attributes hidden)
        }
（途中省略）
Plan: 1 to add, 0 to change, 1 to destroy.
（途中省略）
== stg
（途中省略）
No changes. Your infrastructure matches the configuration.
（途中省略）
== prod
（途中省略）
No changes. Your infrastructure matches the configuration.
```

**▼ 実行結果**（「GitOps Pipeline」の実行#119、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）

```plaintext
== dev
（途中省略）
dev-node1                  : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== stg
（途中省略）
stg-node1                  : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== prod
（途中省略）
target-node1               : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

`terraform plan`には、dev-node1を作り直すことが出ています。一方、`--check --diff`は今あるコンテナに対して動くので、5台とも`changed=0`です。作り直しでユーザーとファイルが消えることは、どちらの材料にも出ていません。

#64をマージし（マージコミット`5bbf696`）、devに適用します。

**▼ 実行結果**（「GitOps Apply」の実行#57、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）

```plaintext
module.lab_env.docker_container.targets["dev-node1"]: Destroying... [id=c6fd49c650bdb9a0547ac82da8fa9ff4f0b49cf575382d2f94467c8f591a39d5]
module.lab_env.docker_container.targets["dev-node1"]: Destruction complete after 0s
module.lab_env.docker_container.targets["dev-node1"]: Creating...
module.lab_env.docker_container.targets["dev-node1"]: Creation complete after 2s [id=2d1667564d9f60a499423bb5a974ac8323b8f4364a642219813e72a42ee6e0a2]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
```

**▼ 実行結果**（「GitOps Apply」の実行#57、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
（途中省略：Pythonインタプリタに関する警告）
--- before
+++ after: /etc/drift-check-target.conf
@@ -0,0 +1 @@
+monitored_by=***-drift-check

changed: [dev-node1]

TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before
+++ after: /etc/gitops-env.conf
@@ -0,0 +1,2 @@
+env=dev
+promotion=dev-stg-prod

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=3    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

新しいコンテナには何も置かれていないので、今のPlaybookにある2つのファイルが、どちらも「なし→あり」の差分で置かれました。適用した後のdev-node1を確認します。

**実行コマンド**

```plaintext
c=dev-node1
docker inspect -f '{{.Id}} {{json .Config.Labels}}' "$c"
docker port "$c"
docker exec "$c" id gitops11; echo "id_exit_code=$?"
docker exec "$c" cat /etc/gitops11-rollback.conf; echo "cat_rollback_exit_code=$?"
docker exec "$c" cat /etc/gitops-env.conf; echo "cat_env_exit_code=$?"
```

**▼ 実行結果**

```plaintext
2d1667564d9f60a499423bb5a974ac8323b8f4364a642219813e72a42ee6e0a2 {"org.opencontainers.image.version":"22.04"}
22/tcp -> 0.0.0.0:2242
id: 'gitops11': no such user
id_exit_code=1
cat: /etc/gitops11-rollback.conf: No such file or directory
cat_rollback_exit_code=1
env=dev
promotion=dev-stg-prod
cat_env_exit_code=0
```

ユーザー`gitops11`とファイル`/etc/gitops11-rollback.conf`は、dev-node1から消えました。消すタスクはどこにも書いていません。今のコードとPlaybookだけからコンテナを作り直した結果、それらを入れるものが何もなかったからです。

同じコミットをstg（#58）とprod（#59）にも適用しました。どちらも`terraform-apply`は`0 added, 0 changed, 0 destroyed`、`ansible-apply`は`changed=0`です。

**▼ 実行結果**（「GitOps Apply」の実行#59、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）

```plaintext
Apply complete! Resources: 0 added, 0 changed, 0 destroyed.
```

コードを変えたのはdevだけなので、作り直しが起きたのもdevだけです。stg-node1とtarget-node1〜3は同じコンテナのまま、ラベル・ユーザー・ファイルが残っています。

### ■ 検証内容：設計B　消すタスクを書く

次は、stgとprodに残ったユーザーとファイルを、「消す」と書いたタスクで消します。`state: absent`の2つのタスクを新しいファイルに書き、`tasks/main.yml`から読み込みます。

* **ファイル名：`ansible/roles/common_setup/tasks/rollback_cleanup.yml`（新規作成）**

```yaml
---
- name: ロールバック確認用のユーザーを削除
  become: true
  ansible.builtin.user:
    name: gitops11
    state: absent
- name: ロールバック確認用のファイルを削除
  become: true
  ansible.builtin.file:
    path: /etc/gitops11-rollback.conf
    state: absent
```

* **ファイル名：`ansible/roles/common_setup/tasks/main.yml`（追加した2行）**

```yaml
- name: ロールバック確認の後片付けのタスクを読み込み
  ansible.builtin.import_tasks: rollback_cleanup.yml
```

この変更でプルリクエスト#65を作ると、確認の`--check --diff`は次のようになりました。

**▼ 実行結果**（「GitOps Pipeline」の実行#121、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）

```plaintext
== dev
（途中省略）
TASK [common_setup : ロールバック確認用のユーザーを削除] ***********************
ok: [dev-node1]

TASK [common_setup : ロールバック確認用のファイルを削除] ***********************
ok: [dev-node1]
（途中省略）
dev-node1                  : ok=5    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== stg
（途中省略）
TASK [common_setup : ロールバック確認用のユーザーを削除] ***********************
changed: [stg-node1]

TASK [common_setup : ロールバック確認用のファイルを削除] ***********************
--- before
+++ after
@@ -1,4 +1,4 @@
 {
     "path": "/etc/gitops11-rollback.conf",
-    "state": "file"
+    "state": "absent"
 }

changed: [stg-node1]
（途中省略）
stg-node1                  : ok=5    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== prod
（途中省略：target-node1〜3もstg-node1と同じく、2つのタスクがchanged）
target-node1               : ok=5    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=5    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=5    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

devは、設計Aで作り直した後なので消すものがなく、`changed=0`です。stgとprodでは、ユーザーとファイルの削除が`changed`になりました。ファイルの削除には`"state": "file"`から`"state": "absent"`への差分が出ています。ユーザーの削除は、**[セクション4](#4-ansibleで追加した変更はrevertで戻らない)** の追加と同じく`changed`の1行だけです。`ansible-lint`とMoleculeも成功しました。Moleculeの新しいコンテナには消すものがないので、`state: absent`のタスクはそのまま通ります。

#65をマージし（マージコミット`5f5208d`）、dev（#60）、stg（#61）、prod（#62）の順に適用します。stgの実行結果は次のとおりです。

**▼ 実行結果**（「GitOps Apply」の実行#61、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
TASK [common_setup : ロールバック確認用のユーザーを削除] ***********************
changed: [stg-node1]

TASK [common_setup : ロールバック確認用のファイルを削除] ***********************
（途中省略：PRの確認と同じ"state"の差分）
changed: [stg-node1]
（途中省略）
stg-node1                  : ok=5    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

devの#60は`changed=0`、prodの#62はtarget-node1〜3とも`changed=2`でした。prodまで適用したところで、5台の状態を確認します。

**実行コマンド**

```plaintext
for c in dev-node1 stg-node1 target-node1 target-node2 target-node3; do
  echo "=== $c ==="
  docker inspect -f '{{.Id}} {{json .Config.Labels}}' "$c"
  docker exec "$c" id gitops11; echo "id_exit_code=$?"
  docker exec "$c" cat /etc/gitops11-rollback.conf; echo "cat_rollback_exit_code=$?"
done
```

**▼ 実行結果**

```plaintext
=== dev-node1 ===
2d1667564d9f60a499423bb5a974ac8323b8f4364a642219813e72a42ee6e0a2 {"org.opencontainers.image.version":"22.04"}
id: 'gitops11': no such user
id_exit_code=1
cat: /etc/gitops11-rollback.conf: No such file or directory
cat_rollback_exit_code=1
=== stg-node1 ===
bd646c528fcac2e8857e3ddf8e710697d1daffadc41f3283a9d121966d8d630a {"gitops.promotion-test":"replace","org.opencontainers.image.version":"22.04"}
id: 'gitops11': no such user
id_exit_code=1
cat: /etc/gitops11-rollback.conf: No such file or directory
cat_rollback_exit_code=1
（途中省略：target-node1〜3もstg-node1と同じく、ラベルは残り、ユーザーとファイルは消えている）
```

### ■ 結果

ユーザー`gitops11`とファイル`/etc/gitops11-rollback.conf`は、5台すべてから消えました。devは設計Aで、stgとprodは設計Bで消えています。

一方、stg-node1とtarget-node1〜3の`gitops.promotion-test=replace`ラベルは残っています。設計Bでは消えません。

### 2つの設計が消せる範囲は違う

2つの設計の結果を並べます。

|観点|設計A：作り直す|設計B：消すタスクを書く|
|---|---|---|
|Terraformのラベル|消えた（dev）|消えない（stg・prodに残った）|
|Ansibleのユーザーとファイル|消えた（dev）|消えた（stg・prod）|
|消える環境|コードを変えて作り直した環境だけ|Playbookを適用した全環境|
|プルリクエストの確認に出るもの|作り直すことだけ。何が消えるかは出ない|消えるホストと、消えるものが出る|
|本番で必要なもの|`allow_destroy`での明示的な許可|特になし（通常の適用）|

設計Aは、何が残っているかを知らなくても、すべてを消せます。今のコードとPlaybookだけから作り直すので、そこに書かれていないものは、ラベルでもユーザーでもファイルでも、新しいコンテナには入りません。その代わり、作り直しを起こすためにコードを変える必要があり、何が消えるのかはプルリクエストの段階では見えません。本番では、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** で確認したとおり、計画のポリシーが作り直しを止めるので、`allow_destroy`で明示的に許可する必要があります。

設計Bは、何が残っているかを知っていて、それを「消す」と書けるときに使えます。プルリクエストの確認に消えるホストと消えるものが出るので、承認する人は、何が消えるのかを適用の前に確かめられます。ただし、消せるのはAnsibleが扱うものだけです。コンテナのラベルはAnsibleの操作対象ではないので、設計Bでは消えません。Terraformの側で、コードに書いていない属性を「消す」と書く方法は、このプロバイダーのラベルにはありません。

### revertは「書いたものを消す」変更ではない

**[セクション5](#5-ansibleでも戻るものと戻らないもの)** で整理したとおり、revertで戻るのは、revertした後のコードに元の状態が書かれているものだけです。タスクやブロックを足した変更をrevertすると、revertの後のコードに書かれているのは「足す前の状態」ではなく「それがない状態」です。Terraformにとっても、Ansibleにとっても、それは「何もしない」ことであって「消す」ことではありません。

設計Bは、この「消す」をコードに書く設計です。足したものを取り消したいときは、revertではなく「消す」と書いた変更を前に進めます。設計Aは、「書いていないものは存在しない」状態を、作り直しで実現する設計です。どちらも、revertの後に何も起きないという問題を、「何かが起きる変更」に置き換えています。

ただし、設計Bで足した`rollback_cleanup.yml`は、今もPlaybookに残っています。消すタスクをいつまで残すのかは、環境が複数あるときに問題になります。次のセクションでは、複数の環境があるときのロールバックを考えます。

---

[↑ 目次に戻る](#-目次)

---

## 7. 複数環境でのロールバック

**[セクション6](#6-両方を戻すための2つの設計)** の設計Bで足した`rollback_cleanup.yml`は、今もPlaybookに残っています。消すタスクは、いつ外してよいのでしょうか。環境が1つなら、適用して消えたことを確かめたら外せます。環境がdev・stg・prodの3つあると、話が変わります。ここでは、消すタスクを全環境に適用し終える前に外すと何が起きるかを確かめます。

### ■ 検証内容：適用の順番を守らせる仕組みを読む

このパイプラインは、dev→stg→prodの順でしか適用できないようにしています。その判定は、「GitOps Apply」の`verify`ジョブにあります。

**実行コマンド**

```plaintext
sed -n '/^  verify:/,/^  terraform-apply:/p' .github/workflows/gitops-apply.yml | cat -n
```

**▼ 実行結果**（抜粋）

```plaintext
    18        - name: Read pending approval
（途中省略）
    28            if [ "$(cat "$d/commit")" != "$GITHUB_SHA" ]; then
    29              echo "::error::pending plan was made from $(cat "$d/commit"), but main is $GITHUB_SHA"
    30              exit 1
    31            fi
    32        - name: Check promotion order
（途中省略）
    42            prev_applied=$(.github/scripts/applied.sh last "$prev")
    43            echo "last applied ($prev): $prev_applied"
    44            if [ "$prev_applied" != "$GITHUB_SHA" ]; then
    45              echo "::error::$GITHUB_SHA has not been applied to $prev yet"
    46              exit 1
    47            fi
（途中省略）
    49        - name: Check commits came from pull requests
（途中省略）
    53            base=$(.github/scripts/applied.sh last "$TARGET_ENV")
（途中省略）
    56            for c in $(git rev-list --first-parent "$base..$GITHUB_SHA"); do
（途中省略）
    60              if [ -n "$pr" ]; then
    61                echo "$c: merge of pull request #$pr"
```

`verify`が確かめていることは3つです。

* 承認待ちのコミットが、今のmainの先頭と同じか（28行目）
* 1つ前の環境に「最後に適用したコミット」が、今のコミットと同じか（44行目）
* この環境に前回適用したコミットから今のコミットまでが、すべてプルリクエストのマージか（56〜61行目）

承認待ちは、mainにマージされるたびに、「GitOps Pipeline」の`record-pending`ジョブが3環境分すべて書き直します。そのため、適用できるのは常に最新のmainだけです。また、途中のコミットを1つ前の環境やこの環境に適用したかどうかは、どこでも確かめていません。

### ■ 検証内容：5台にファイルを置く

消すものを用意するため、ファイル`/etc/gitops11-multi.conf`を置くタスクを足します。

* **ファイル名：`ansible/roles/common_setup/tasks/multi_env.yml`（新規作成）**

```yaml
---
- name: 複数環境の確認用のファイルを配置
  become: true
  ansible.builtin.copy:
    dest: /etc/gitops11-multi.conf
    content: "added_by=gitops11-multi\n"
    mode: "0644"
```

* **ファイル名：`ansible/roles/common_setup/tasks/main.yml`（追加した2行）**

```yaml
- name: 複数環境の確認のタスクを読み込み
  ansible.builtin.import_tasks: multi_env.yml
```

この変更をプルリクエスト#66としてマージし（マージコミット`c591d40`）、dev（#63）、stg（#64）、prod（#65）の順に適用しました。3環境とも、ファイルを置くタスクが`changed`になりました。

**実行コマンド**

```plaintext
for c in dev-node1 stg-node1 target-node1 target-node2 target-node3; do
  echo "=== $c ==="
  docker exec "$c" cat /etc/gitops11-multi.conf; echo "cat_multi_exit_code=$?"
done
```

**▼ 実行結果**

```plaintext
=== dev-node1 ===
added_by=gitops11-multi
cat_multi_exit_code=0
=== stg-node1 ===
added_by=gitops11-multi
cat_multi_exit_code=0
（途中省略：target-node1〜3も同じ）
```

### ■ 検証内容：消す変更をdevにだけ適用する

`multi_env.yml`のタスクを、ファイルを消すタスクに書き換えます。

**実行コマンド**

```plaintext
git diff
```

**▼ 実行結果**

```plaintext
diff --git a/ansible/roles/common_setup/tasks/multi_env.yml b/ansible/roles/common_setup/tasks/multi_env.yml
index 62cd375..eeaf795 100644
--- a/ansible/roles/common_setup/tasks/multi_env.yml
+++ b/ansible/roles/common_setup/tasks/multi_env.yml
@@ -1,7 +1,6 @@
 ---
-- name: 複数環境の確認用のファイルを配置
+- name: 複数環境の確認用のファイルを削除
   become: true
-  ansible.builtin.copy:
-    dest: /etc/gitops11-multi.conf
-    content: "added_by=gitops11-multi\n"
-    mode: "0644"
+  ansible.builtin.file:
+    path: /etc/gitops11-multi.conf
+    state: absent
```

この変更でプルリクエスト#67を作ると、確認の`--check --diff`には、5台すべてでファイルが消える差分が出ました。

**▼ 実行結果**（「GitOps Pipeline」の実行#125、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）

```plaintext
== dev
（途中省略）
TASK [common_setup : 複数環境の確認用のファイルを削除] *************************
--- before
+++ after
@@ -1,4 +1,4 @@
 {
     "path": "/etc/gitops11-multi.conf",
-    "state": "file"
+    "state": "absent"
 }

changed: [dev-node1]
（途中省略：stg-node1、target-node1〜3も同じ差分でchanged）
```

#67をマージすると（マージコミット`a337eea`）、3環境の承認待ちが`a337eea`で書かれました。

**▼ 実行結果**（「GitOps Pipeline」の実行#126、`record-pending`ジョブのステップ「Record pending approval」から抜粋）

```plaintext
== dev
（途中省略）
commit=a337eea112578d7e44f9e82bcd9af4114a9b230c
（途中省略）
== stg
（途中省略）
commit=a337eea112578d7e44f9e82bcd9af4114a9b230c
（途中省略）
== prod
（途中省略）
commit=a337eea112578d7e44f9e82bcd9af4114a9b230c
```

ここで、devにだけ適用します。

**▼ 実行結果**（「GitOps Apply」の実行#66、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
TASK [common_setup : 複数環境の確認用のファイルを削除] *************************
--- before
+++ after
@@ -1,4 +1,4 @@
 {
     "path": "/etc/gitops11-multi.conf",
-    "state": "file"
+    "state": "absent"
 }

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

devでファイルが消えました。stgとprodには、まだ適用していません。

### ■ 検証内容：stgとprodに適用する前に、消すタスクを外す

devで消えたのを見て、消すタスクはもう要らないと判断した、という想定です。`multi_env.yml`を消し、`main.yml`から読み込みの2行を外します。

**実行コマンド**

```plaintext
git rm ansible/roles/common_setup/tasks/multi_env.yml
sed -i '/複数環境の確認のタスクを読み込み/,+1d' ansible/roles/common_setup/tasks/main.yml
cat -n ansible/roles/common_setup/tasks/main.yml
```

**▼ 実行結果**

```plaintext
rm 'ansible/roles/common_setup/tasks/multi_env.yml'
     1  ---
     2  - name: ドリフト検知のタスクを読み込み
     3    ansible.builtin.import_tasks: drift_check.yml
     4  - name: 環境の名前のタスクを読み込み
     5    ansible.builtin.import_tasks: environment.yml
     6  - name: ロールバック確認の後片付けのタスクを読み込み
     7    ansible.builtin.import_tasks: rollback_cleanup.yml
```

この変更でプルリクエスト#68を作ると、確認の`--check --diff`は5台とも`changed=0`でした。stgとprodにはファイルが残っていますが、それに触れるタスクはもうないので、何も出ません。

**▼ 実行結果**（「GitOps Pipeline」の実行#127、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）

```plaintext
== dev
（途中省略）
dev-node1                  : ok=5    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== stg
（途中省略）
stg-node1                  : ok=5    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== prod
（途中省略）
target-node1               : ok=5    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=5    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=5    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

#68をマージすると（マージコミット`945d52c`）、3環境の承認待ちが`945d52c`で書き直されました。stgとprodの承認待ちにあった`a337eea`は、一度も適用されないまま消えました。

**▼ 実行結果**（「GitOps Pipeline」の実行#128、`record-pending`ジョブのステップ「Record pending approval」から抜粋）

```plaintext
== dev
（途中省略）
commit=945d52c2df1bd52d688b9dbc271e62d4bee23c1a
（途中省略）
== stg
（途中省略）
commit=945d52c2df1bd52d688b9dbc271e62d4bee23c1a
（途中省略）
== prod
（途中省略）
commit=945d52c2df1bd52d688b9dbc271e62d4bee23c1a
```

dev（#67）に適用したあと、stgに適用します。

**▼ 実行結果**（「GitOps Apply」の実行#68、`verify`ジョブのステップ「Check promotion order」と「Check commits came from pull requests」から抜粋）

```plaintext
last applied (dev): 945d52c2df1bd52d688b9dbc271e62d4bee23c1a
945d52c2df1bd52d688b9dbc271e62d4bee23c1a has been applied to dev
（途中省略）
last applied (stg): c591d40a6b98d65d491febb98cf9a20f07678337
945d52c2df1bd52d688b9dbc271e62d4bee23c1a: merge of pull request #68
a337eea112578d7e44f9e82bcd9af4114a9b230c: merge of pull request #67
```

**▼ 実行結果**（「GitOps Apply」の実行#68、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
（途中省略）
stg-node1                  : ok=5    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

`verify`は、stgに前回適用した`c591d40`から今の`945d52c`までに、プルリクエスト#67と#68の2つのマージがあることを見つけています。それでも、確かめているのは「どちらもプルリクエストのマージか」だけなので、そのまま通りました。prod（#69）も同じく、#67と#68の2行が並んで通り、target-node1〜3とも`changed=0`でした。

prodまで適用したところで、5台の状態と、適用の記録を確認します。

**実行コマンド**

```plaintext
for c in dev-node1 stg-node1 target-node1 target-node2 target-node3; do
  echo "=== $c ==="
  docker exec "$c" cat /etc/gitops11-multi.conf; echo "cat_multi_exit_code=$?"
done
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 7;'
```

**▼ 実行結果**

```plaintext
=== dev-node1 ===
cat: /etc/gitops11-multi.conf: No such file or directory
cat_multi_exit_code=1
=== stg-node1 ===
added_by=gitops11-multi
cat_multi_exit_code=0
=== target-node1 ===
added_by=gitops11-multi
cat_multi_exit_code=0
=== target-node2 ===
added_by=gitops11-multi
cat_multi_exit_code=0
=== target-node3 ===
added_by=gitops11-multi
cat_multi_exit_code=0
 id | env  |                commit_sha
----+------+------------------------------------------
 43 | prod | 945d52c2df1bd52d688b9dbc271e62d4bee23c1a
 42 | stg  | 945d52c2df1bd52d688b9dbc271e62d4bee23c1a
 41 | dev  | 945d52c2df1bd52d688b9dbc271e62d4bee23c1a
 40 | dev  | a337eea112578d7e44f9e82bcd9af4114a9b230c
 39 | prod | c591d40a6b98d65d491febb98cf9a20f07678337
 38 | stg  | c591d40a6b98d65d491febb98cf9a20f07678337
 37 | dev  | c591d40a6b98d65d491febb98cf9a20f07678337
(7 rows)
```

### ■ 結果

3環境とも、最新の`945d52c`まで適用したと記録されました。それでも、ファイルが消えたのはdevだけで、stgとprodの4台には残っています。

|コミット|dev|stg|prod|
|---|---|---|---|
|`c591d40`（#66：ファイルを置く）|id 37|id 38|id 39|
|`a337eea`（#67：ファイルを消す）|id 40|なし|なし|
|`945d52c`（#68：消すタスクを外す）|id 41|id 42|id 43|

`a337eea`が適用されたのはdevだけです。stgとprodは、`c591d40`から`945d52c`へ直接進みました。

### 環境ごとに、通ってきたコミットが違う

GitOpsでは、mainが「あるべき状態」を表すと考えがちです。しかし、各環境に実際に適用されたのは、mainの履歴のすべてではありません。適用するたびに、その時点で最新のmainが当たるだけです。devに適用してからstgに適用するまでの間に次のマージがあると、stgはその前のコミットを飛ばして、新しいコミットを受け取ります。

ファイルを置く、値を変える、といった変更なら、飛ばしても困りません。新しいコミットにも、その状態が書かれているからです。困るのは「消す」変更です。**[セクション5](#5-ansibleでも戻るものと戻らないもの)** と **[セクション6](#6-両方を戻すための2つの設計)** で見たとおり、消すことは、それが書かれたコミットを適用したときにしか起きません。消すタスクを外したコミットには、もう消すことが書かれていないので、それを受け取った環境では何も起きません。

確認の材料も、この残りものを示しませんでした。

|段階|結果|
|---|---|
|#68の確認（`--check --diff`）|5台とも`changed=0`。stgとprodのファイルには触れない|
|`verify`（stg・prod）|#67の存在は一覧に出るが、「プルリクエストのマージか」だけを確かめて通過|
|適用（stg・prod）|4台とも`changed=0`|
|記録（`gitops.applied`）|3環境とも`945d52c`が「最後に適用したコミット」|

### 消すタスクを外してよいのは、全環境に当たってから

消すタスクを外してよいのは、そのタスクを含むコミットが、すべての環境に適用されたあとです。それを確かめる材料は、`gitops.applied`にあります。各環境の記録に、消すタスクを含むコミットがあるかを見れば判断できます。今回なら、`a337eea`の行がdevにしかないので、まだ外してはいけなかったことが分かります。

**[セクション6](#6-両方を戻すための2つの設計)** で残しておいた`rollback_cleanup.yml`は、それを足したコミット`5f5208d`を、dev・stg・prodの3環境すべてに適用しています（「GitOps Apply」の実行#60〜#62）。こちらは、今外しても、消し漏れは起きません。

revertでも同じことが起きます。足した変更をdevにだけ適用したあとでrevertをマージすると、stgとprodは、足すことも戻すことも通らずに進みます。この場合は、もともと何も入っていないので困りません。しかし、「消す」変更をrevertで取り消したり、消すタスクを外したりしたときは、今回と同じく、まだ当たっていない環境に残りものが残ります。

次のセクションでは、ここまでの非対称性が、クラウドのリソースでも同じように起きるのかを考えます。

---

[↑ 目次に戻る](#-目次)

---

## 8. クラウドでは何が同じで何が変わるか

ここまでの検証の操作対象は、Dockerのコンテナでした。操作対象がクラウドの仮想マシンやマネージドサービスになったとき、同じことが起きるのかを、ここまでの結果をもとに整理します。このセクションでは、クラウドでの実機の検証はしていません。ここまでの結果のうち、どれが操作対象の種類に関係なく起きることで、どれが操作対象しだいで変わることなのかを分けて考えます。

### Ansibleの側は、操作対象がクラウドでも同じ

**[セクション4](#4-ansibleで追加した変更はrevertで戻らない)** で残ったユーザーとファイル、**[セクション7](#7-複数環境でのロールバック)** でstgとprodに残ったファイルは、どちらもAnsibleの比べ方から起きたことです。Ansibleは、そのときのPlaybookに書かれたタスクだけを、操作対象の今の状態と比べます。Playbookから消えたタスクが入れたものには、比べる相手がありません。

この比べ方は、操作対象がコンテナでも、クラウドの仮想マシンでも変わりません。仮想マシンの中は、コンテナと同じくOSです。Playbookからタスクを消すrevertをすれば、そのタスクが入れたものは仮想マシンの中に残ります。**[セクション5](#5-ansibleでも戻るものと戻らないもの)** の「タスクが残っていれば値は戻る」も、**[セクション6](#6-両方を戻すための2つの設計)** の設計B（消すタスクを書く）も、同じように当てはまります。

### Terraformの側は、プロバイダーと属性しだい

**[セクション3](#3-terraformでもrevertで戻るとは限らない)** では、コードから消したラベルは戻らず、コードに書いたまま値を戻したポートは戻りました。ラベルが戻らなかったのは、Dockerプロバイダーがラベルを「コードに書かれていなければ、今の値を残す」属性として扱っていたからです。revertの後の`terraform plan`には、`labels (known after apply)`と出て、`No changes`でした。

この扱いは、Terraformそのものではなく、プロバイダーが属性ごとに決めています。コードに書かれていない属性を「消す」と扱う属性もあれば、「今の値を残す」と扱う属性もあります。後者の属性をコードから消しても、計画には何も出ないことがあり、プロバイダーの開発者向けにも課題として議論されています（**[HashiCorp Discuss](https://discuss.hashicorp.com/t/how-to-force-resource-replacement-when-computed-optional-attribute-removed-from-config/69679)**）。

そのため、クラウドのプロバイダーでも、「revertで戻る属性」と「戻らない属性」が混ざっていると考えておく必要があります。どちらなのかは、属性ごとに確かめるしかありません。確かめる材料は、revertのプルリクエストの`terraform plan`です。消したはずの属性について、計画に変更が出ていなければ、その属性はrevertでは戻りません。**[セクション3](#3-terraformでもrevertで戻るとは限らない)** の#57が、まさにその形でした。

### 作り直しは、残しておきたいものも消す

**[セクション6](#6-両方を戻すための2つの設計)** の設計A（作り直す）で残りものが消えたのは、今のコードとPlaybookに書かれていないものが、新しいコンテナには何も入らなかったからです。この理由は、そのまま裏返ります。コードにもPlaybookにも書かれていないものは、残しておきたいものであっても、作り直しで消えます。

クラウドの仮想マシンでは、ディスクに書かれたデータや、手作業で入れた設定が、そこに当たります。作り直しで残りものを消せるかどうかは、「書かれていないものは消えてよい」と言える状態になっているかどうかで決まります。本番の環境で、計画のポリシーが作り直しを止め、`allow_destroy`での明示的な許可を求めるのも、このためです。

### 複数環境の問題は、パイプラインの問題

**[セクション7](#7-複数環境でのロールバック)** で、stgとprodが消す変更を飛ばしたのは、パイプラインが「最新のmainだけを適用する」作りだったからです。操作対象がコンテナかクラウドかには関係しません。クラウドでも、同じ作りのパイプラインを使えば、同じことが起きます。

### まとめると

|ここまでの結果|クラウドでは|
|---|---|
|Ansibleのタスクを消すrevertでは、入れたものが残る（**[セクション4](#4-ansibleで追加した変更はrevertで戻らない)**）|同じ。仮想マシンの中でも残る|
|タスクが残っていれば、値はrevertで戻る（セクション5）|同じ|
|Terraformでは、コードから消した属性が戻らないことがある（**[セクション3](#3-terraformでもrevertで戻るとは限らない)**）|プロバイダーと属性しだい。revertの計画で確かめる|
|作り直すと、書かれていないものはすべて消える（セクション6）|同じ。残しておきたいデータも消える|
|消す変更を全環境に当てる前に外すと、残りものが残る（セクション7）|同じ。パイプラインの作りで決まる|

操作対象しだいで変わるのは、Terraformの属性の扱いだけです。それ以外は、TerraformとAnsibleの比べ方と、パイプラインの作りで決まります。これは、この連載の副題「Terraformプロバイダーを問わない構成管理の自動化」とも重なります。プロバイダーを問わずに起きることは、プロバイダーを問わずに設計で手当てする必要があります。

---

[↑ 目次に戻る](#-目次)

---

## 9. まとめ

この回で整理した内容を確認します。

* `git revert`は、Gitの上では変更の取り消しだが、インフラに何が起きるかは、適用するツールの比べ方で決まる。Terraformはコードに書かれた属性とブロックだけを、AnsibleはそのときのPlaybookに書かれたタスクだけを、操作対象の今の状態と比べる。revertで戻るのは、revertの後のコードに、元の状態が書かれているものだけである
* Terraformでも、revertで戻るとは限らない。コンテナにラベルのブロックを足した変更をrevertすると、3環境とも`No changes`になり、ラベルは5台のコンテナに残った。プロバイダーが、書かれていないラベルを`known after apply`として扱い、今の値を残したためである。一方、コードに書いたまま値を戻したポートは戻った。ただし戻り方はコンテナの作り直しで、stgとprodでは`allow_destroy`の許可が要る
* Ansibleで、ユーザーとファイルを足した変更をrevertすると、プルリクエストの`--check --diff`も、適用も、5台とも`changed=0`だった。`ansible-lint`とMoleculeも成功し、`gitops.applied`にはrevertのコミットが「最後に適用したコミット」として記録された。それでも、5台すべてにユーザーとファイルが残った。消えたタスクが入れたものには、比べる相手がないためである。また、`user`モジュールは`--diff`の差分を出さず、ユーザーが増えることは`changed`の1行としてしか見えなかった
* 今あるタスクの値を変えた変更は、revertで戻った。タスクがPlaybookに残り、元の値が書かれているので、Ansibleが書き戻す。プルリクエストの確認には、5台それぞれに戻る差分が出た。ただし、差分が出ることは「戻る」ことの材料になるが、差分が出ないことは「戻らないものがない」ことの材料にはならない
* revertで戻らなかったものを戻す設計として、作り直す設計と、消すタスクを書く設計を試した。作り直すと、コードとPlaybookに書かれていないものは、ラベルもユーザーもファイルもすべて消えた。ただし、作り直しを起こすにはコードを変える必要があり、プルリクエストの確認には作り直すことしか出ない。消すタスク（`state: absent`）を書くと、消えるホストと消えるものが確認に出た。ただし、消せるのはAnsibleが扱うものだけで、コンテナのラベルは残った
* 複数の環境があると、消すタスクを外す時期が問題になる。承認待ちは、mainへのマージのたびに3環境分すべて書き直され、適用できるのは常に最新のmainだけである。順序の確認は、途中のコミットが適用されたかを見ない。消すタスクをdevにだけ適用したあとで外すと、stgとprodは消すタスクを一度も通らずに進み、ファイルが残った。消すタスクを外してよいのは、それを含むコミットが、すべての環境の`gitops.applied`に記録されてからである
* 操作対象がクラウドになっても、Ansibleの側の残りもの、作り直しで書かれていないものがすべて消えること、複数環境で消す変更が飛ばされることは変わらない。操作対象しだいで変わるのは、Terraformで、コードから消した属性をプロバイダーがどう扱うかだけである。どちらに当たるかは、revertのプルリクエストの`terraform plan`で確かめる

---

[↑ 目次に戻る](#-目次)

---

## 10. 次回予告

本シリーズの **[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** までで、dev・stg・prodの3つの環境に、同じmainのコミットを、決めた順序でしか届けない仕組みがそろいました。第11回となる今回は、その仕組みの上で`git revert`によるロールバックを行い、TerraformとAnsibleのどちらでも、revertで戻るものと戻らないものがあることを、実機で確認しました。戻らなかったものに対しては、作り直す設計と、消すタスクを書いて前に進める設計を試し、それぞれが消せる範囲と、プルリクエストの確認に何が出るかを比べました。さらに、複数の環境では、消す変更が一部の環境で飛ばされ、残りものが残ることを示しました。

ここまでの回では、パイプラインが止まる場面を、何度も見てきました。順序の確認による停止、planのポリシーによる停止、ガードレールの結果による停止は、どれも設計どおりの停止です。一方で、パイプラインは、設計していない理由でも止まります。ランナーの環境、ツールの前提条件、認証情報など、止まる理由は層ごとに異なります。止まったときに、それが設計どおりの停止なのか、故障なのかを見分けられなければ、ガードレールは「よく止まる邪魔なもの」になってしまいます。

**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** では、パイプラインの失敗を、GitHub Actions・ガードレール・Terraform・Ansibleの4つの層に分けて、「設計どおりの停止か、故障か」を切り分ける方法を整理します。第2部の最終回です。

**[次回：第12回：失敗したパイプラインをどう診断するか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)　｜　[次の記事：【GitOps編】第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**

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
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**|git revertしてもOSは戻らない：ロールバックの非対称性|TerraformでもAnsibleでも、revertで戻るのは「revertの後のコードに元の状態が書かれているもの」だけであることを実機で示す。戻らないものを戻す2つの設計と、複数環境で消す変更が飛ばされる問題を整理する。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**|失敗したパイプラインをどう診断するか|パイプラインの失敗をGitHub Actions・ガードレール・Terraform・Ansibleの4層に分け、「設計どおりの停止か、故障か」を切り分ける。Ansible×Terraformシリーズ第3部の知識を活用する。第2部の最終回。|

---

[↑ 目次に戻る](#-目次)

---