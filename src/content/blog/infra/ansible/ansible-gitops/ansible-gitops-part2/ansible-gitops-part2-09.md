---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第9回：Terraform側にもガードレールを置く'
description: 'Terraformのチェックを、書かれた内容を見る静的なチェックと、起きる変化を見るplanのチェックの2層に分けて整理する。静的なチェックの効き目がプロバイダーで変わることを実測したうえで、planのJSONから作り直しと削除を読み取り、Ansibleで入れた設定が消える変更を、承認ゲートの入口で止める構成を作る。チェックするのは承認待ちとして保存したplanそのもので、チェックしたplan、承認したplan、適用するplanが一致する。'
pubDate: 2026-10-10
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'GitHub Actions', 'terraform plan']
seriesId: 'ansible-gitops-part2'
seriesNo: 9
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/'
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
2. [Terraformのチェックは2層ある](#2-terraformのチェックは2層ある)
3. [静的チェックの効き目はプロバイダーで変わる](#3-静的チェックの効き目はプロバイダーで変わる)
4. [planのJSONから変更の種類を取り出す](#4-planのjsonから変更の種類を取り出す)
5. [再生成を含むplanを検知する](#5-再生成を含むplanを検知する)
6. [パイプラインに組み込んで、止まる場所を確かめる](#6-パイプラインに組み込んで止まる場所を確かめる)
7. [クラウドプロバイダーではガードレールの価値が上がる](#7-クラウドプロバイダーではガードレールの価値が上がる)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#10-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

TerraformのコードをGitで管理し、プルリクエストで静的なチェックを実行していて、

* `terraform validate`とtflintを、CIで実行するようにした
* どちらも、エラーなく通過した
* よって、このTerraformの変更は、安全に適用できる

と考えていないでしょうか。

TerraformのCIを扱う記事の多くは、`terraform fmt`、`terraform validate`、tflint、セキュリティ設定のチェックツールといった、静的なチェックの導入を中心にしています。適用しようとしているplanの中身を、機械的に評価するチェックや、その変更がAnsibleで入れた設定にどう影響するかは、あまり扱われていません。AnsibleとTerraformのパイプラインで静的なチェックを運用し始めると、次のような場面にぶつかります。

* `terraform validate`もtflintも通ったのに、適用したらコンテナが作り直され、Ansibleで入れた設定が消えた
* Dockerプロバイダーでは、tflintがほとんど何も指摘しない
* planの差分が長く、承認するときに、作り直しを示す1行を見落とした
* Ansibleの側にはチェックを置いたのに、Terraformの側は、承認する人がplanを読むことに頼ったままになっている

これらは、チェックのツールやルールの選び方の問題に見えます。共通しているのは、静的なチェックが見ているのはコードに書かれた内容であって、そのコードを適用したときにインフラで何が起きるかではない点です。そして、Terraformの変更で実際に何が起きるかが確定するのは、承認して適用するplanです。

Terraformの変更とAnsibleの設定の関係は、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）で扱ってきました。Ansible×Terraformシリーズの **[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)** では、`terraform validate`、`terraform fmt -check`、ansible-lintが、それぞれ独立した基準で判定し、ある判定を通ったことが別の判定を通ることを意味しないことを確認しました。**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** では、`name`属性の変更や`replace_triggered_by`によってコンテナが作り直されると、Ansibleで入れた設定が失われることを確認しました。`name`属性の変更では、ファイルとパッケージのどちらも失われ、しかも`terraform apply`はエラーも警告も出さずに完了しています。**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)** では、`prevent_destroy`が破棄を伴う計画を`terraform plan`と`terraform apply`の時点で拒否する一方、意図しない破棄と意図した再構築を区別せず、`for_each`で作ったリソースにはインスタンスごとに設定できないことを確認しました。

同じシリーズの **[第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)** では、`terraform show -json`で取り出したplanの`actions`と`type`から、コンテナの作り直しを検出し、GitHub Actionsのジョブを失敗させる仕組みを作りました。この仕組みは、**[第48回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/)** でAnsibleの設定をイメージに焼き込む運用に転換したうえで、意図しない作り直しそのものを検知するために置いたものです。**[第50回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-50/)** では、このガードを、破棄が計画された事実を人の目に触れさせる、着脱可能な一時的なチェックの工程にとどまると整理しています。**[第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)** で確認したのは、ワークフローの中で作ったplanを検査し、ジョブを失敗させるところまでです。検査したplanと、承認して適用するplanが同じかどうかは扱っておらず、止めた後の扱いも、承認の機能を使う選択肢として整理するにとどめています。

本シリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** では、`docker_container`に環境変数を1つ加えるだけの、`main.tf`だけの変更でも、コンテナの作り直し（`must be replaced`）になることを確認しました。そのうえで、作り直しを伴う変更では、作り直したコンテナに、Playbookの全タスクを適用し直す必要があると整理しました。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション2では、`terraform/`の変更でAnsibleの実行が必要かどうかは、変更したファイルからは決まらず、`terraform plan`の結果を見て決めるとしました。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション6では、この判定を省き、Terraformが動いたら常にAnsibleも動かす、安全側に倒した構成にしました。planの中身を読み取る仕組みは、この回に送っています。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、マージで作ったplanを承認待ちとして保存し、手動で起動する承認ゲートを通ったときにだけ、そのplanそのものを適用する構成を作りました。**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** では、Ansibleの側にansible-lintとMoleculeをガードレールとして置き、承認ゲートの入口でチェックの結果を確かめて、チェックを通っていないコミットを適用しない構成を作りました。一方で、Terraformの側は、承認する人がplanを読むことに頼ったまま残っています。

第9回となる今回は、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** と対になる回として、Terraformの側にもガードレールを置きます。まず、Terraformのチェックを、コードに書かれた内容を見る静的なチェックと、planに現れる変化を見るチェックの2層に分けて整理します。次に、静的なチェックを、この検証環境のコードと、AWSのリソースを書いた最小のコードに実行し、効き目がプロバイダーで変わることを実測します。そのうえで、planのJSONから、リソースごとの変更の種類を取り出し、作り直しと削除を検知する判定を作ります。Ansible×Terraformシリーズの **[第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)** の判定の条件で、取りこぼす変更の種類があるかも確かめます。判定は、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** で承認待ちとして保存したplanそのものに対して、承認ゲートの入口で実行します。作り直しや削除を含むplanは止め、承認する人が明示的に許可したときだけ通して、その場合はAnsibleを必ず実行します。静的なチェックの結果も、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** と同じ入口で確かめます。最後に、このガードレールが、クラウドのプロバイダーで持つ意味を整理します。

正確に言うと、**静的なチェックが見るのは「書かれた内容」であり、GitOpsで適用の前に止めたいのは、承認して適用するplanに現れる「起きる変化」です**。この回で扱う問いは、「Terraformの変更で、Ansibleで入れた設定が消えることを、適用の前に機械的に止めるには、何をどこで確かめればよいのか」です。

次のセクションでは、Terraformのチェックを、2つの層に分けて整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. Terraformのチェックは2層ある

Terraformの変更に対して置けるチェックを、何を入力にして判定するかで2つの層に分けて整理します。

### 静的なチェック：コードに書かれた内容を見る

1つ目の層は、Terraformのコードを入力にして、適用する前に、書かれた内容だけを見て判定するチェックです。この回で扱うのは、次の4つです。

|チェック|見るもの|
|---|---|
|`terraform fmt -check`|コードの書き方が、Terraformの整形のルールに沿っているか|
|`terraform validate`|コードが、構文として正しく、内部で矛盾していないか|
|tflint|コードに、ルールに反する書き方や、設定の誤りが含まれていないか|
|セキュリティ設定のチェックツール|コードに、セキュリティ上問題のある設定が含まれていないか|

Terraformの公式ドキュメント（**[terraform validate](https://developer.hashicorp.com/terraform/cli/commands/validate)**）では、`terraform validate`は、構成が構文として正しく、内部で矛盾していないかを、渡された変数や既存のtfstateに関係なく確かめるものとされています。`terraform fmt -check`と`terraform validate`が別の基準で判定することは、Ansible×Terraformシリーズの **[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)** で確認済みです。tflintとセキュリティ設定のチェックツールも、同じく適用の前に、コードを読むだけで判定します。

4つに共通しているのは、tfstateも、実際のインフラも、判定の入力にしていない点です。同じコミットのコードに対しては、いつ実行しても、どこで実行しても、同じ結果になります。

### planのチェック：起きる変化を見る

2つ目の層は、`terraform plan`の結果を入力にして判定するチェックです。planは、コードだけでなく、計画を作った時点のtfstateと、プロバイダーから読み取った実際のリソースの属性を比べて作られます。そのため、planには、そのコードを今適用したときに、どのリソースがどう変わるかが現れます。

`terraform plan -out`で保存したplanは、`terraform show -json`でJSONの形で取り出せます。公式ドキュメント（**[JSON Output Format](https://developer.hashicorp.com/terraform/internals/json-format)**）では、このJSONに、リソースごとの変更の内容が含まれるとされています。Ansible×Terraformシリーズの **[第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)** で確認したとおり、リソースごとの`actions`を見れば、作成、更新、作り直しといった変更の種類を、表示の文言を読まずに判定できます。

planのチェックの結果は、同じコミットのコードでも、計画を作った時点のtfstateと実際のインフラによって変わります。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション2で確認したとおり、プルリクエストで見たplanと、マージの後に作るplanは、同じとは限りません。

### 静的なチェックからは、作り直しは見えない

2つの層の違いが表れるのが、作り直しです。

**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション3では、`docker_container`に環境変数を1つ加えただけで、コンテナが作り直しになることを確認しました。コードとして見れば、`env`という有効な属性に、有効な値を書いただけです。書き方にも構文にも誤りはなく、静的なチェックが止める理由はありません。その変更が作り直しになるかどうかは、プロバイダーがその属性の変更をどう扱うかと、今のtfstateの値との比較で決まり、planを作って初めて分かります。

作り直しは、変更したリソースの外からも起こります。Ansible×Terraformシリーズの **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** では`replace_triggered_by`によって、**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** ではネットワークの`id`の参照によって、直接は変更していないコンテナまで作り直しの対象になりました。どのリソースが、どの参照を通じて作り直しに巻き込まれるかも、コードの1か所を読むだけでは分からず、planに現れます。

**[セクション1](#1-はじめに)** で挙げた「`terraform validate`もtflintも通ったのに、適用したらコンテナが作り直された」という場面は、この違いから生まれます。静的なチェックを通ったことは、書かれた内容に問題が見つからなかったことを意味するだけで、適用で何が起きるかについては何も言っていません。

### planのチェックにも、見えないものがある

一方で、planのチェックも万能ではありません。planに現れるのは、tfstateに記録されたリソースの属性の変化までです。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション3で整理したとおり、コンテナの中にAnsibleで入れた設定は、tfstateの観測範囲の外にあります。planに現れるのは「コンテナが作り直される」ことまでで、「その中の設定が消える」ことは現れません。

そのため、この回のplanのチェックは、コンテナの作り直しや削除を検知したときに、それを「Ansibleで入れた設定が失われる変更」とみなして扱う形をとります。設定が消えることそのものを観測しているのではなく、作り直しという変化から、設定の消失を推定していることになります。

### GitOpsでは、planのチェックが承認ゲートと直結する

2つの層を、GitOpsのパイプラインの中に置いたときの違いを並べると、次のとおりです。

|項目|静的なチェック|planのチェック|
|---|---|---|
|判定の入力|コミットのコード|コード、計画を作った時点のtfstate、実際のリソースの属性|
|見るもの|書かれた内容|起きる変化|
|同じコミットでの結果|いつ実行しても同じ|計画を作った時点によって変わりうる|
|止められるもの|書き方の誤り、設定の誤り、危険な設定値|作り直し、削除など、適用で起きる変化|
|止められないもの|適用で何が起きるか|tfstateの外の変化（コンテナの中の設定の消失そのもの）|
|この回で確かめる場所|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** と同じく、適用するコミットに対する結果を入口で確かめる|承認待ちとして保存したplanそのものを、入口で評価する|

静的なチェックは、結果がコミットで決まるため、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** のansible-lintとMoleculeと同じく、適用するコミットに付いた結果を確かめれば足ります。

planのチェックは、結果がplanを作った時点で変わるため、どのplanを評価するかが問題になります。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** で作った承認ゲートでは、マージで作ったplanを承認待ちとして保存し、そのplanそのものを適用します。この保存したplanを評価すれば、評価したplanと、承認する人が見るplanと、適用されるplanが同じものになります。planのチェックは、承認ゲートの材料そのものを機械的に読むチェックとして、承認ゲートと直結します。

この点は、Ansibleの側とは対照的です。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4で確認したとおり、Ansibleの`--check --diff`の出力は予測にとどまり、保存して、そのとおりに適用する仕組みがありません。Ansibleの側では、適用で起きる変化を、適用の前に確定した形で評価することはできず、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** のガードレールは、Playbookの書き方と、テスト用の環境での収束を確かめるものでした。Terraformの側は、適用するplanそのものを評価できます。

次のセクションでは、静的なチェックを、この検証環境のコードに実行し、その効き目がプロバイダーで変わることを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 3. 静的チェックの効き目はプロバイダーで変わる

**[セクション2](#2-terraformのチェックは2層ある)** で整理した静的なチェックを、この検証環境のTerraformのコードと、AWSのリソースを書いた最小のコードに実行し、何が指摘されるかを実機で確認します。あわせて、今のmainが静的なチェックを通るかを確かめ、通る状態にします。

### この検証環境のツール

この回では、tflintと、セキュリティ設定のチェックツールとしてTrivyを使います。Trivyは、Terraformのコードのほかに、`Dockerfile`なども検査の対象にできるツールです。どちらも、公開されているチェックサムでダウンロードしたファイルを照合したうえで、self-hostedランナーのホストに導入しました。**[セクション6](#6-パイプラインに組み込んで止まる場所を確かめる)** では、パイプラインのジョブからも、同じホストのツールを使います。

**実行コマンド**

```plaintext
terraform version | head -1
tflint --version
trivy --version
```

**▼ 実行結果**

```plaintext
Terraform v1.15.7
TFLint version 0.64.0
+ ruleset.terraform (0.15.0-bundled)
Version: 0.75.0
```

tflintは0.64.0、Trivyは0.75.0です。tflintに同梱されているルールのまとまり（ルールセット）は、`ruleset.terraform`だけです。この回の判定は、これらのバージョンでの実測です。

### ■ 検証内容：今のterraform/に、4つのチェックを実行する

`terraform/`で管理しているファイルは、次のとおりです。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
git ls-files .
```

**▼ 実行結果**

```plaintext
.terraform.lock.hcl
Dockerfile
Dockerfile.deploy_nopasswd
Dockerfile.deploy_passwd
Dockerfile.legacy
id_ed25519.pub
main.tf
outputs.tf
```

まず、`terraform fmt -check`と`terraform validate`を実行します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
terraform fmt -check -recursive; echo "exit_code=$?"
terraform validate -no-color; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
exit_code=0
Success! The configuration is valid.

exit_code=0
```

続いて、tflintを実行します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
tflint; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
1 issue(s) found:

Warning: terraform "required_version" attribute is required (terraform_required_version)

  on main.tf line 1:
   1: terraform {

Reference: https://github.com/terraform-linters/tflint-ruleset-terraform/blob/v0.15.0/docs/rules/terraform_required_version.md

exit_code=2
```

最後に、Trivyを実行します。Trivyは、指摘があっても既定では成功の終了コードを返すため、`--exit-code 1`を付けて、指摘があれば失敗する形で実行します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
trivy config --exit-code 1 .; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
（途中省略：検査のルールのダウンロードの表示）
2026-10-08T23:38:32Z    INFO    [terraform scanner] Scanning root module        file_path="."
2026-10-08T23:38:32Z    WARN    [terraform parser] Variable values were not found in the environment or variable files. Evaluating may not work correctly.      module="root" variables="ansible_user_password, deploy_user_password"
2026-10-08T23:38:32Z    INFO    Detected config files   num=5

Report Summary

┌────────────────────────────┬────────────┬───────────────────┐
│           Target           │    Type    │ Misconfigurations │
├────────────────────────────┼────────────┼───────────────────┤
│ .                          │ terraform  │         0         │
├────────────────────────────┼────────────┼───────────────────┤
│ Dockerfile                 │ dockerfile │         5         │
├────────────────────────────┼────────────┼───────────────────┤
│ Dockerfile.deploy_nopasswd │ dockerfile │         5         │
├────────────────────────────┼────────────┼───────────────────┤
│ Dockerfile.deploy_passwd   │ dockerfile │         5         │
├────────────────────────────┼────────────┼───────────────────┤
│ Dockerfile.legacy          │ dockerfile │         5         │
└────────────────────────────┴────────────┴───────────────────┘
（途中省略：凡例）

Dockerfile (dockerfile)
=======================
Tests: 27 (SUCCESSES: 22, FAILURES: 5)
Failures: 5 (UNKNOWN: 0, LOW: 1, MEDIUM: 1, HIGH: 2, CRITICAL: 1)

DS-0002 (HIGH): Specify at least 1 USER command in Dockerfile with non-root user as argument
（途中省略：説明）
DS-0004 (MEDIUM): Port 22 should not be exposed in Dockerfile
（途中省略：説明と該当箇所）
DS-0026 (LOW): Add HEALTHCHECK instruction in your Dockerfile
（途中省略：説明）
DS-0029 (HIGH): '--no-install-recommends' flag is missed: （途中省略）
（途中省略：説明と該当箇所）
DS-0031 (CRITICAL): Possible exposure of secret env "ANSIBLE_USER_PASSWORD" in ARG
（途中省略：説明と該当箇所）

（途中省略：Dockerfile.deploy_nopasswd、Dockerfile.deploy_passwd、Dockerfile.legacyの、同じ5種類の指摘）
exit_code=1
```

### ■ 結果

4つのチェックの結果は、次のとおりです。

|チェック|対象|結果|
|---|---|---|
|`terraform fmt -check`|`terraform/`|指摘なし（`exit_code=0`）|
|`terraform validate`|`terraform/`|`Success!`（`exit_code=0`）|
|tflint|`terraform/`|1件（`terraform_required_version`、`exit_code=2`）|
|Trivy|Terraformのコード|0件|
|Trivy|`Dockerfile`4つ|各5件（DS-0002、DS-0004、DS-0026、DS-0029、DS-0031）、全体で`exit_code=1`|

tflintの指摘は、`terraform`ブロックに`required_version`（使うTerraformのバージョンの範囲）がないという1件だけでした。これは、Terraformの書き方の一般的なルールによる指摘で、Dockerプロバイダーの使い方には関係しません。tflintに同梱されているのは`ruleset.terraform`だけで、`docker_container`や`docker_image`の書き方を確かめるルールは含まれていません。

Trivyは、Terraformのコードに対しては、1件も指摘しませんでした。指摘はすべて、`docker_image`が読む`Dockerfile`に対するものです。

|指摘|内容（要約）|この検証環境での位置づけ|
|---|---|---|
|DS-0002|非rootのユーザーで実行する`USER`の指定がない|操作対象のイメージの設計|
|DS-0004|22番のポートを公開している|AnsibleがSSHで接続するため、操作対象として必要|
|DS-0026|`HEALTHCHECK`の指定がない|操作対象のイメージの設計|
|DS-0029|`apt-get install`に`--no-install-recommends`がない|操作対象のイメージの設計|
|DS-0031|`ARG`でパスワードを渡している|機密情報の扱い|

DS-0031は、イメージを作るときに、ユーザーのパスワードを`ARG`で渡していることへの指摘です。この検証環境では、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** から、パスワードをSecretsから`TF_VAR_`で渡し、Terraformが`build_args`としてイメージのビルドに渡しています。機密情報の扱いとして、第3部の **[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** で扱います。

この回では、ガードレールとして止める範囲を、Trivyの検査のうちTerraformのコードに絞ります。この回の対象は、Terraformの変更で起きることです。また、DS-0004のように、操作対象の設計として必要な指摘もあります。`Dockerfile`の指摘を個別に除外する方法もありますが、除外の指定を重ねると、CRITICALのDS-0031まで同じ扱いで黙らせることになります。そこで、除外はせずに検査の範囲を絞り、`Dockerfile`の指摘は、この実測のとおり残っているものとして扱います。

### ■ 検証内容：AWSのリソースを書いた最小のコード

同じ2つのツールを、AWSのリソースを書いた最小のコードに実行します。コードは`/tmp`の下に置き、`terraform init`も`terraform apply`も実行せず、AWSの認証情報も使いません。

セキュリティグループでSSH（22番）を`0.0.0.0/0`に開け、インスタンスの`instance_type`は、存在しない`t3.micr0`にわざと誤記しています。tflintは、AWS向けのルールセット（**[tflint-ruleset-aws](https://github.com/terraform-linters/tflint-ruleset-aws)**）を、設定ファイル`.tflint.hcl`で指定して取得します。

**実行コマンド**

```plaintext
AWS_RULESET_VER=$(curl -s https://api.github.com/repos/terraform-linters/tflint-ruleset-aws/releases/latest | jq -r '.tag_name' | sed 's/^v//')
echo "AWS_RULESET_VER=$AWS_RULESET_VER"
mkdir -m 700 /tmp/gitops09-aws && cd /tmp/gitops09-aws
cat > main.tf <<'EOF'
terraform {
  required_version = "~> 1.15"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = "ap-northeast-1"
}

resource "aws_security_group" "ssh" {
  name        = "gitops09-ssh"
  description = "gitops09 sample"

  ingress {
    description = "ssh"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "target" {
  ami                    = "ami-0123456789abcdef0"
  instance_type          = "t3.micr0"
  vpc_security_group_ids = [aws_security_group.ssh.id]
}
EOF
cat > .tflint.hcl <<EOF
plugin "aws" {
  enabled = true
  version = "${AWS_RULESET_VER}"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
EOF
cat -n .tflint.hcl
tflint --init
```

**▼ 実行結果**

```plaintext
AWS_RULESET_VER=0.49.0
     1  plugin "aws" {
     2    enabled = true
     3    version = "0.49.0"
     4    source  = "github.com/terraform-linters/tflint-ruleset-aws"
     5  }
Installing "aws" plugin...
Installed "aws" (source: github.com/terraform-linters/tflint-ruleset-aws, version: 0.49.0)
```

AWS向けのルールセットは0.49.0です。この状態で、tflintとTrivyを実行します。

**実行コマンド**

```plaintext
cd /tmp/gitops09-aws
tflint; echo "exit_code=$?"
trivy config --exit-code 1 .; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
1 issue(s) found:

Error: "t3.micr0" is an invalid value as instance_type (aws_instance_invalid_type)

  on main.tf line 30:
  30:   instance_type          = "t3.micr0"

exit_code=2
（途中省略：Trivyの開始の表示）

Report Summary

┌─────────┬───────────┬───────────────────┐
│ Target  │   Type    │ Misconfigurations │
├─────────┼───────────┼───────────────────┤
│ .       │ terraform │         0         │
├─────────┼───────────┼───────────────────┤
│ main.tf │ terraform │         3         │
└─────────┴───────────┴───────────────────┘
（途中省略：凡例）

main.tf (terraform)
===================
Tests: 3 (SUCCESSES: 0, FAILURES: 3)
Failures: 3 (UNKNOWN: 0, LOW: 0, MEDIUM: 0, HIGH: 3, CRITICAL: 0)

AWS-0028 (HIGH): Instance does not require IMDS access to require a token.
（途中省略：説明と該当箇所）
AWS-0107 (HIGH): Security group rule allows unrestricted ingress from any IP address.
（途中省略：説明）
 main.tf:24
   via main.tf:19-25 (ingress)
    via main.tf:15-26 (aws_security_group.ssh)
（途中省略：該当箇所）
AWS-0131 (HIGH): Root block device is not encrypted.
（途中省略：説明と該当箇所）

exit_code=1
```

確認に使ったファイルと、AWS向けのルールセットの置き場所（`~/.tflint.d`）は、この後に削除しました。

### ■ 結果

同じ2つのツールの指摘を、2つのコードで並べると、次のとおりです。

|ツール|この検証環境（Dockerプロバイダー）|AWSのリソースを書いた最小のコード|
|---|---|---|
|tflint|1件。`required_version`がない（Terraformの書き方の一般的なルール）|1件。`"t3.micr0"`は存在しないインスタンスタイプ（AWS向けのルール）|
|Trivy（Terraformのコード）|0件|3件。IMDSv2を必須にしていない（AWS-0028）、SSHを`0.0.0.0/0`に開けている（AWS-0107）、ルートのブロックデバイスを暗号化していない（AWS-0131）|

Dockerプロバイダーのコードに対して、2つのツールが指摘したのは、プロバイダーに関係しない書き方の1件だけでした。AWSのコードに対しては、同じ2つのツールが、存在しない値の指定と、3つの危険な設定を、コードを読むだけで見つけています。tflintは、プロバイダー向けのルールセットを別に取得して初めて、そのプロバイダーの値の誤りを確かめられます。Trivyの検査のルールにも、AWSのリソースに向けたものが含まれていました。

静的なチェックの効き目は、ツールそのものではなく、使っているプロバイダー向けのルールがあるかどうかで決まります。この検証環境で指摘が少なかったことは、コードに問題がないことを意味しません。Dockerプロバイダー向けのルールが、ほとんどないことを意味しています。

### ■ 検証内容：今のmainを、静的チェックを通る状態にする

静的なチェックをガードレールとしてパイプラインに組み込むには、まず今のmainが通る必要があります。作業用のブランチで、`main.tf`の`terraform`ブロックに`required_version`を加えます。範囲は、この検証環境で使っているv1.15.7を含む`~> 1.15`にしました。

Trivyは、ガードレールで使うのと同じく、`--misconfig-scanners terraform`を付けて、Terraformのコードだけを検査の対象にします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops09-tf-baseline
sed -i '1a\  required_version = "~> 1.15"' terraform/main.tf
git --no-pager diff
cd terraform
terraform fmt -check -recursive; echo "exit_code=$?"
terraform validate -no-color; echo "exit_code=$?"
tflint; echo "exit_code=$?"
trivy config --misconfig-scanners terraform --exit-code 1 . 2>&1 | tail -12; echo "exit_code=${PIPESTATUS[0]}"
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform plan -detailed-exitcode > /dev/null 2>&1; echo "plan_exit_code=$?"
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops09-tf-baseline'
diff --git a/terraform/main.tf b/terraform/main.tf
index 4b059ba..5adabb8 100644
--- a/terraform/main.tf
+++ b/terraform/main.tf
@@ -1,4 +1,5 @@
 terraform {
+  required_version = "~> 1.15"
   backend "pg" {}

   required_providers {
exit_code=0
Success! The configuration is valid.

exit_code=0
exit_code=0

Report Summary

┌────────┬───────────┬───────────────────┐
│ Target │   Type    │ Misconfigurations │
├────────┼───────────┼───────────────────┤
│ .      │ terraform │         0         │
└────────┴───────────┴───────────────────┘
（途中省略：凡例）

exit_code=0
plan_exit_code=0
```

4つのチェックはすべて通り、`terraform plan`は変更なし（`plan_exit_code=0`）でした。この変更をコミットしてプッシュします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git add terraform/main.tf
git commit -m "GitOps第9回: tflintを通すため、required_versionを指定する"
git push -u origin gitops09-tf-baseline
```

**▼ 実行結果**

```plaintext
[gitops09-tf-baseline dadcc3a] GitOps第9回: tflintを通すため、required_versionを指定する
 1 file changed, 1 insertion(+)
（途中省略：プッシュの表示）
```

このブランチから、プルリクエスト（`#44`）を作成しました。確認の実行は、「GitOps Pipeline」の`#79`です。

**▼ 実行結果（プルリクエスト`#44`の「GitOps Pipeline」の実行`#79`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
terraform/main.tf
base=67a8241151364323fa1c36531ba6495a051a4cf1
terraform=true
***=false
```

ログの中の`***`は、`ansible`です。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション5で確認したとおり、この検証環境では、Secretsの値と一致する語が、ログの中で伏せられます。この回のログでは、`ansible`のほかに`deploy`も同じく伏せられています。

**▼ 実行結果（「GitOps Pipeline」の実行`#79`、`terraform-plan`ジョブのステップ「Terraform plan」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.
```

**▼ 実行結果（「GitOps Pipeline」の実行`#79`、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

`terraform/`だけの変更なので、`changes`、`terraform-plan`、`ansible-check`が動き、`ansible-lint`、`molecule`、`record-pending`はスキップされました。確認の実行が成功した後に、`#44`をマージしました（マージコミット`53c8be1`）。マージで起動した「GitOps Pipeline」の実行`#80`で、planが保存され、承認待ちが記録されました。

**▼ 実行結果（`#44`のマージの「GitOps Pipeline」の実行`#80`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
total 32
-rw------- 1 control control     6 Oct  9 00:16 ***
-rw------- 1 control control    41 Oct  9 00:16 base
-rw------- 1 control control    41 Oct  9 00:16 commit
-rw------- 1 control control     5 Oct  9 00:16 terraform
-rw------- 1 control control 14848 Oct  9 00:16 tfplan
base=67a8241151364323fa1c36531ba6495a051a4cf1
commit=53c8be1a743b8a4bc536f12c4286eb6ad3ca250a
terraform=true
***=false
```

この承認待ちを、「GitOps Apply」を、ブランチ「main」、破棄のチェックなしで起動して適用しました。次の画像は、その実行`#14`です。`verify`、`terraform-apply`、`ansible-apply`、`clear-pending`が成功し、`discard`はスキップされています。

![GitOps Applyの実行#14。コミット53c8be1に対して手動で起動され、verify、terraform-apply、ansible-apply、clear-pendingが成功し、discardはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/section3-tf-baseline-apply-run.png)

**▼ 実行結果（「GitOps Apply」の実行`#14`、`verify`ジョブのステップ「Check commits came from pull requests」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
53c8be1a743b8a4bc536f12c4286eb6ad3ca250a: merge of pull request #44
```

**▼ 実行結果（「GitOps Apply」の実行`#14`、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

（途中省略：Outputsの表示）
```

**▼ 実行結果（「GitOps Apply」の実行`#14`、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

最後に、作業用のブランチを削除し、終了時点の状態を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline -2
git branch -d gitops09-tf-baseline
git push origin --delete gitops09-tf-baseline
git branch -a
git status --short; echo "git_status_exit_code=$?"
ls -la ~/gitops-pending; echo "exit_code=$?"
cd terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform plan -detailed-exitcode > /dev/null 2>&1; echo "plan_exit_code=$?"
tflint; echo "exit_code=$?"
cd ../ansible
ansible-playbook -i dynamic_inventory.py site.yml --check 2>/dev/null | tail -4
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えと、オブジェクトの受信の表示）
53c8be1 (HEAD -> main, origin/main) Merge pull request #44 from juehara-crypto/gitops09-tf-baseline
dadcc3a (origin/gitops09-tf-baseline, gitops09-tf-baseline) GitOps第9回: tflintを通すため、required_versionを指定する
Deleted branch gitops09-tf-baseline (was dadcc3a).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops09-tf-baseline
* main
  remotes/origin/main
git_status_exit_code=0
ls: cannot access '/home/control/gitops-pending': No such file or directory
exit_code=2
plan_exit_code=0
exit_code=0
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

mainは`53c8be1`になり、mainのTerraformのコードは、4つの静的なチェックを通る状態になりました。承認待ちは適用の後に削除され、`terraform plan`は変更なし、確認モードは3台とも`changed=0`です。`required_version`を加えても、インフラは何も変わっていません。

このセクションで確認したことを並べると、次のとおりです。

* この検証環境のTerraformのコードに対して、tflintが指摘したのは、プロバイダーに関係しない`required_version`の1件だけで、TrivyはTerraformのコードに1件も指摘しなかった
* 同じ2つのツールが、AWSのリソースを書いた最小のコードでは、存在しないインスタンスタイプと、3つの危険な設定を、`terraform init`も認証情報も使わずに指摘した。静的なチェックの効き目は、使っているプロバイダー向けのルールがあるかどうかで決まる
* Trivyは、`docker_image`が読む`Dockerfile`に、各5件の指摘を出した。この回のガードレールでは、検査の範囲をTerraformのコードに絞り、機密情報に関わるDS-0031は第3部で扱う
* `required_version`を加え、プルリクエストと承認ゲートを通して適用した

ただし、ここまでの静的なチェックは、手元で実行しただけです。しかも、「GitOps Apply」の実行`#14`では、`verify`ジョブのステップ「Check guardrail results」がスキップされていました。このステップは、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** で、承認待ちの`ansible`の判定が`true`のときだけ動くように作ったものです。今の構成では、`terraform/`だけの変更は、承認ゲートの入口で何のチェックの結果も確かめられずに、適用まで進みます。静的なチェックをパイプラインに組み込み、その結果を入口で確かめる構成は、**[セクション6](#6-パイプラインに組み込んで止まる場所を確かめる)** で扱います。

また、この検証環境のように、静的なチェックがほとんど何も指摘しない環境では、静的なチェックだけでは、Terraformの変更で何が起きるかについて、ほぼ何も分かりません。次のセクションでは、もう1つの層である、planに現れる変化を、JSONから取り出します。

---

[↑ 目次に戻る](#-目次)

---

## 4. planのJSONから変更の種類を取り出す

`terraform show -json`で取り出したplanのJSONから、リソースごとの変更の種類を取り出し、作り直しや削除がどう表現されるかを、実機で確認します。確認はすべて`terraform plan -out`までで、`terraform apply`は実行しません。

### planのJSONは、全体を表示しない

公式ドキュメント（**[JSON Output Format](https://developer.hashicorp.com/terraform/internals/json-format)**）では、planのJSONに、計画した変更の前後の値が含まれるとされています。`terraform plan`の画面で`(sensitive value)`と伏せられる値が、JSONでも同じように伏せられるとは限りません。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション3で整理したとおり、この検証環境のplanには、Ansibleの接続に使う秘密鍵が含まれている可能性があります。そのため、この回では、planファイルを本人だけが読めるディレクトリに置き、JSONの全体は表示せずに、`jq`で取り出した項目だけを表示します。

### ■ 検証内容：変更のないplanのJSONの形

変更のない状態でplanを保存し、JSONの最上位の項目と、リソースごとの変更の種類を取り出します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
mkdir -m 700 ~/gitops09-plans
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-base" > /dev/null); echo "plan_exit_code=$?"
terraform show -json "$HOME/gitops09-plans/tfplan-base" | jq -r 'keys[]'
terraform show -json "$HOME/gitops09-plans/tfplan-base" | jq -r '.format_version, .terraform_version'
terraform show -json "$HOME/gitops09-plans/tfplan-base" | jq -r '.resource_changes[] | [.address, .type, (.change.actions | join(","))] | @tsv'
```

**▼ 実行結果**

```plaintext
plan_exit_code=0
applyable
complete
configuration
errored
format_version
output_changes
planned_values
prior_state
resource_changes
terraform_version
timestamp
variables
1.2
1.15.7
docker_container.targets["target-node1"]        docker_container        no-op
docker_container.targets["target-node2"]        docker_container        no-op
docker_container.targets["target-node3"]        docker_container        no-op
docker_image.ansible_target     docker_image    no-op
docker_image.ansible_target_deploy_nopasswd     docker_image    no-op
docker_image.ansible_target_deploy_passwd       docker_image    no-op
docker_image.ansible_target_legacy      docker_image    no-op
docker_network.app_net  docker_network  no-op
docker_network.lab_net  docker_network  no-op
tls_private_key.generated       tls_private_key no-op
```

### ■ 結果

JSONの形式のバージョン（`format_version`）は`1.2`、Terraformのバージョンは`1.15.7`でした。リソースごとの変更は、`resource_changes`の配列に入っています。変更がない状態でも、Terraformが管理している10個のリソースが、すべて`no-op`（変更なし）として並んでいます。以降の確認では、`no-op`以外の要素だけを取り出します。

### ■ 検証内容：作り直し

**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション3と同じく、target-node1にだけ環境変数を渡す変更を、手元の`main.tf`に一時的に加えます。変更の種類（`actions`）に加えて、変更の理由（`action_reason`）と、作り直しの原因になった属性（`replace_paths`）も取り出します。最後の`jq`は、Ansible×Terraformシリーズの **[第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)** の判定の条件（`actions`が`["delete","create"]`で、`type`が`docker_container`）で数えた件数です。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
sed -i '/^  image    = docker_image.ansible_target.image_id$/a\  env      = each.key == "target-node1" ? ["APP_ENV=production"] : []' main.tf
git --no-pager diff
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-env" > /dev/null); echo "plan_exit_code=$?"
terraform show -json "$HOME/gitops09-plans/tfplan-env" | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | [.address, .type, (.change.actions | join(",")), (.action_reason // "-")] | @tsv'
terraform show -json "$HOME/gitops09-plans/tfplan-env" | jq -c '.resource_changes[] | select(.change.actions != ["no-op"]) | {address, replace_paths: .change.replace_paths}'
terraform show -json "$HOME/gitops09-plans/tfplan-env" | jq '[.resource_changes[] | select(.change.actions == ["delete","create"] and .type == "docker_container")] | length'
git restore main.tf
```

**▼ 実行結果**

```plaintext
diff --git a/terraform/main.tf b/terraform/main.tf
index 5adabb8..44672b0 100644
--- a/terraform/main.tf
+++ b/terraform/main.tf
@@ -92,6 +92,7 @@ resource "docker_container" "targets" {
   for_each = local.target_nodes
   name     = each.key
   image    = docker_image.ansible_target.image_id
+  env      = each.key == "target-node1" ? ["APP_ENV=production"] : []
   dynamic "networks_advanced" {
     for_each = local.target_node_networks[each.key]
     content {
plan_exit_code=0
docker_container.targets["target-node1"]        docker_container        delete,create   replace_because_cannot_update
{"address":"docker_container.targets[\"target-node1\"]","replace_paths":[["env"]]}
1
```

### ■ 結果

target-node1は、`actions`が`["delete","create"]`、`action_reason`が`replace_because_cannot_update`（更新できないため作り直す）になりました。`replace_paths`は`[["env"]]`で、作り直しの原因が`env`の属性であることも、JSONから特定できます。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** で、画面の`must be replaced`と`# forces replacement`から読み取っていた内容が、この3つの項目に対応しています。第49回の条件でも、1件として数えられました。

### ■ 検証内容：作成、削除、順序を逆にした作り直し、鍵とネットワークの作り直し

同じ取り出し方で、ほかの変更を順に確認します。どのケースも、確認の後に`main.tf`を元に戻しています。

まず、target-node4を加える変更です。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
sed -i '/^    "target-node3" = 2223$/a\    "target-node4" = 2224' main.tf
sed -i '/^    "target-node3" = \[docker_network.lab_net.name\]$/a\    "target-node4" = [docker_network.lab_net.name]' main.tf
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-add" > /dev/null); echo "plan_exit_code=$?"
terraform show -json "$HOME/gitops09-plans/tfplan-add" | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | [.address, .type, (.change.actions | join(",")), (.action_reason // "-")] | @tsv'
terraform show -json "$HOME/gitops09-plans/tfplan-add" | jq '[.resource_changes[] | select(.change.actions == ["delete","create"] and .type == "docker_container")] | length'
git restore main.tf
```

**▼ 実行結果**

```plaintext
plan_exit_code=0
docker_container.targets["target-node4"]        docker_container        create  -
0
```

次に、target-node3を外す変更です。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
sed -i '/^    "target-node3" = 2223$/d' main.tf
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-del" > /dev/null); echo "plan_exit_code=$?"
terraform show -json "$HOME/gitops09-plans/tfplan-del" | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | [.address, .type, (.change.actions | join(",")), (.action_reason // "-")] | @tsv'
terraform show -json "$HOME/gitops09-plans/tfplan-del" | jq '[.resource_changes[] | select(.change.actions == ["delete","create"] and .type == "docker_container")] | length'
git restore main.tf
```

**▼ 実行結果**

```plaintext
plan_exit_code=0
docker_container.targets["target-node3"]        docker_container        delete  delete_because_each_key
0
```

続いて、環境変数を加える変更に、`create_before_destroy = true`を組み合わせます。Ansible×Terraformシリーズの **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で確認したとおり、この検証環境では固定のポートがぶつかるため`terraform apply`は失敗しますが、ここではplanでの表現だけを見ます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
sed -i '/^  image    = docker_image.ansible_target.image_id$/a\  env      = each.key == "target-node1" ? ["APP_ENV=production"] : []' main.tf
sed -i '/^  lifecycle {$/a\    create_before_destroy = true' main.tf
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-cbd" > /dev/null); echo "plan_exit_code=$?"
terraform show -json "$HOME/gitops09-plans/tfplan-cbd" | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | [.address, .type, (.change.actions | join(",")), (.action_reason // "-")] | @tsv'
terraform show -json "$HOME/gitops09-plans/tfplan-cbd" | jq '[.resource_changes[] | select(.change.actions == ["delete","create"] and .type == "docker_container")] | length'
git restore main.tf
```

**▼ 実行結果**

```plaintext
plan_exit_code=0
docker_container.targets["target-node1"]        docker_container        create,delete   replace_because_cannot_update
0
```

続いて、Ansibleの接続に使う鍵（`tls_private_key.generated`）を作り直す場合です。Ansible×Terraformシリーズの **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** と **[第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)** では、`terraform taint`でtfstateに印を付けて作り直しを起こしましたが、ここではtfstateを変えないように、`terraform plan`の`-replace`で指定します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
(umask 077; terraform plan -input=false -replace=tls_private_key.generated -out="$HOME/gitops09-plans/tfplan-key" > /dev/null); echo "plan_exit_code=$?"
terraform show -json "$HOME/gitops09-plans/tfplan-key" | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | [.address, .type, (.change.actions | join(",")), (.action_reason // "-")] | @tsv'
terraform show -json "$HOME/gitops09-plans/tfplan-key" | jq '[.resource_changes[] | select(.change.actions == ["delete","create"] and .type == "docker_container")] | length'
```

**▼ 実行結果**

```plaintext
plan_exit_code=0
docker_container.targets["target-node1"]        docker_container        delete,create   replace_because_cannot_update
docker_container.targets["target-node2"]        docker_container        delete,create   replace_because_cannot_update
docker_container.targets["target-node3"]        docker_container        delete,create   replace_because_cannot_update
tls_private_key.generated       tls_private_key delete,create   replace_by_request
3
```

最後に、コンテナがつながっているネットワーク`lab_net`に、今と同じサブネットを明示する変更を加えます。Ansible×Terraformシリーズの **[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** では、この種の変更でネットワークが作り直しになり、コンテナが`id`で参照していた場合は、コンテナまで作り直しになりました。この検証環境のコンテナは、`main.tf`の`target_node_networks`で、ネットワークを`name`で参照しています。

**実行コマンド**

```plaintext
docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' ansible-lab-net
cd ~/iac/docker-lab-ci/terraform
sed -i '/^  name = "ansible-lab-net"$/a\  ipam_config {\n    subnet = "172.19.0.0/16"\n  }' main.tf
git --no-pager diff
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-net" > /dev/null); echo "plan_exit_code=$?"
terraform show -json "$HOME/gitops09-plans/tfplan-net" | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | [.address, .type, (.change.actions | join(",")), (.action_reason // "-")] | @tsv'
terraform show -json "$HOME/gitops09-plans/tfplan-net" | jq '[.resource_changes[] | select(.change.actions == ["delete","create"] and .type == "docker_container")] | length'
git restore main.tf
```

**▼ 実行結果**

```plaintext
172.19.0.0/16
diff --git a/terraform/main.tf b/terraform/main.tf
index 5adabb8..bc0b801 100644
--- a/terraform/main.tf
+++ b/terraform/main.tf
@@ -69,6 +69,9 @@ resource "docker_image" "ansible_target_legacy" {
 # 2. 検証用ネットワークの作成
 resource "docker_network" "lab_net" {
   name = "ansible-lab-net"
+  ipam_config {
+    subnet = "172.19.0.0/16"
+  }
 }
 resource "docker_network" "app_net" {
   name = "ansible-app-net"
plan_exit_code=0
docker_network.lab_net  docker_network  delete,create   replace_because_cannot_update
0
```

確認に使ったplanファイルを削除し、終了時点の状態を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
rm -rf ~/gitops09-plans
ls -d ~/gitops09-plans; echo "exit_code=$?"
git status --short; echo "git_status_exit_code=$?"
cd terraform
terraform plan -detailed-exitcode > /dev/null 2>&1; echo "plan_exit_code=$?"
```

**▼ 実行結果**

```plaintext
ls: cannot access '/home/control/gitops09-plans': No such file or directory
exit_code=2
git_status_exit_code=0
plan_exit_code=0
```

### ■ 結果

planファイルは削除し、作業ツリーにも、tfstateにも、変更は残っていません。

6つの変更を並べると、次のとおりです。

|変更|変化が現れたリソース|`actions`|`action_reason`|
|---|---|---|---|
|target-node1に環境変数を追加|target-node1|`["delete","create"]`|`replace_because_cannot_update`|
|target-node4を追加|target-node4|`["create"]`|なし|
|target-node3を外す|target-node3|`["delete"]`|`delete_because_each_key`|
|`create_before_destroy`と環境変数の追加|target-node1|`["create","delete"]`|`replace_because_cannot_update`|
|鍵の作り直し|target-node1〜3、`tls_private_key.generated`|すべて`["delete","create"]`|コンテナは`replace_because_cannot_update`、鍵は`replace_by_request`|
|`lab_net`にサブネットを明示|`docker_network.lab_net`|`["delete","create"]`|`replace_because_cannot_update`|

`actions`の配列で、作成（`["create"]`）、削除（`["delete"]`）、作り直し（`["delete","create"]`と`["create","delete"]`）を、画面の表示を読まずに区別できました。作り直しは、削除と作成の組み合わせとして表され、`create_before_destroy`を付けると、その順序が配列の並びに反映されます。`action_reason`からは、作り直しや削除の理由も読み取れます。

一方、第49回の条件は、`["delete","create"]`との完全一致です。この条件で数えた件数は、環境変数の追加が1件、鍵の作り直しが3件（コンテナ3台）で、ほかの4つは0件でした。0件のうち、target-node4の追加を除く次の3つは、Ansibleで入れた設定が失われうる変更です。

* target-node3の削除。コンテナが失われ、Ansibleで入れた設定もなくなるが、作り直しではない
* `create_before_destroy`を付けた作り直し。順序が逆になるだけで、作り直したコンテナからAnsibleで入れた設定が失われることは変わらない
* コンテナがつながっているネットワークの作り直し

最後のケースでは、コンテナはplanに1台も現れませんでした。コンテナがネットワークを`name`で参照しているため、ネットワークが作り直されても、コンテナの側の値は変わらないと計算されたと考えられます。ただし、コンテナがつながったままのネットワークを作り直したときに、実際にコンテナがどうなるかは、planからは分かりません。この検証環境を壊すおそれがあるため、この回では`terraform apply`による確認はしていません。

鍵の作り直しでは、コンテナのコードを1行も変えていないのに、3台とも作り直しになりました。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション6で確認したとおり、コンテナの`upload`は、鍵から作った公開鍵を中身に含んでいます。鍵が作り直されれば中身が変わり、コンテナは作り直しになります。今の`main.tf`には`replace_triggered_by`はなく、この連鎖は参照だけで起きています。planのJSONでは、変更したリソースだけでなく、参照を通じて巻き込まれたリソースも、それぞれの`actions`を持って並びます。

planのJSONから分かるのは、どのリソースが、どの理由で、作成、削除、作り直しになるかまでです。**[セクション2](#2-terraformのチェックは2層ある)** で整理したとおり、コンテナの中のAnsibleで入れた設定が失われることそのものは、JSONにも現れません。次のセクションでは、取り出した変更の種類から、Ansibleで入れた設定が失われる変更を判定し、止める仕組みを作ります。

---

[↑ 目次に戻る](#-目次)

---

## 5. 再生成を含むplanを検知する

**[セクション4](#4-planのjsonから変更の種類を取り出す)** で取り出した変更の種類から、Ansibleで入れた設定が失われる変更を判定するスクリプトを作り、手元の実機で確認します。止めた後の扱いも、ここで決めます。

### 判定のルール

判定は、planのJSONの`resource_changes`のうち、`no-op`以外の要素を、次の2つに分けます。

|判定|条件|
|---|---|
|止める|`actions`に`"delete"`を含む（`["delete"]`、`["delete","create"]`、`["create","delete"]`）。リソースの種類は問わない|
|通す|それ以外（`["create"]`、`["update"]`）|

Ansible×Terraformシリーズの **[第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)** の条件との違いは、次の2点です。

* `actions`が`["delete","create"]`と完全に一致するかではなく、`"delete"`を含むかで見る。**[セクション4](#4-planのjsonから変更の種類を取り出す)** で確認したとおり、コンテナの削除は`["delete"]`、`create_before_destroy`を付けた作り直しは`["create","delete"]`になり、どちらもAnsibleで入れた設定が失われる
* リソースの種類で絞らない。**[セクション4](#4-planのjsonから変更の種類を取り出す)** のネットワークの作り直しでは、コンテナはplanに1台も現れなかった。コンテナがつながっているリソースの作り直しが、コンテナに何をするかはplanから分からないため、コンテナ以外の削除と作り直しも止める側に入れる

作成（`["create"]`）は通します。新しく作ったコンテナにも、Ansibleで設定を入れる必要はありますが、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション6で組んだとおり、`terraform/`に変更があれば、`ansible-apply`は必ず動きます。失われる設定がないため、止める理由はありません。

### 止めた後の扱い

止めた変更の中には、意図した再構築もあります。止めるだけでは、Ansible×Terraformシリーズの **[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)** の`prevent_destroy`と同じく、意図した再構築まで進められなくなります。そこで、止めた後の扱いを、次のように決めました。

* 承認ゲートの入口で、承認待ちのplanをこの判定にかけ、止める対象があれば適用しない
* 承認する人が、判定の結果を見たうえで、「GitOps Apply」の起動のときに、削除と作り直しを許可する入力に明示的にチェックを入れた場合だけ、適用に進む
* 許可して適用した場合も、`terraform/`の変更なので、`ansible-apply`は必ず動き、Playbookの全体（`site.yml`）を実行する。作り直したコンテナに、全タスクを適用し直すことになる

**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** では、「Terraformが動いたら、Ansibleも必ず動く」という順序を保証しました。この回の判定は、その上に、「作り直しや削除があるときは、承認する人がそれを知ったうえで許可しない限り、Terraformも動かない」という条件を加えるものです。許可したときに、Ansibleの実行が飛ばされることはありません。

`prevent_destroy`との違いは、Ansible×Terraformシリーズの **[第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)** のセクション6で、実装の場所、拒否の性質、解除の方法の3つの点で整理されています。この回の判定は、それに加えて次の点で異なります。

|項目|`prevent_destroy`（**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)**）|この回の判定|
|---|---|---|
|判定の単位|リソースの定義ごと。`for_each`のインスタンスごとには設定できない|planに現れたリソースのアドレスごと。どのインスタンスが、どの変更の種類と理由で止まったかが出力される|
|変更の種類の区別|破棄を伴う計画を、一律に拒否する|削除と作り直しは止め、作成と更新は通す|
|止めた後の出口|`main.tf`から設定を外すコミットが必要|承認ゲートの起動のときの、明示的な許可の入力|

### ■ 検証内容：判定のスクリプトの作成

作業用のブランチ`gitops09-guardrails`に、判定のスクリプトを作ります。置き場所は、`terraform/`や`ansible/`ではなく、`.github/scripts/`にしました。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のパスの判定で、スクリプトの変更が、Terraformの変更やAnsibleの変更として扱われないようにするためです。

スクリプトは、`terraform show -json`の出力を標準入力で受け取ります。JSONをファイルに書き出さずに済ませるためです。止める対象（`BLOCK`）に加えて、通す変更（`PASS`）も1行ずつ表示し、止める対象があれば終了コード1で終わります。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops09-guardrails
mkdir -p .github/scripts
cat > .github/scripts/plan-policy.sh <<'EOF'
（スクリプトの内容。下のcat -nの結果と同じ）
EOF
chmod +x .github/scripts/plan-policy.sh
cat -n .github/scripts/plan-policy.sh
bash -n .github/scripts/plan-policy.sh; echo "syntax_exit_code=$?"
git add .github/scripts/plan-policy.sh
git commit -m "GitOps第9回: planから削除と作り直しを検知するスクリプトを追加"
git log --oneline -2
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops09-guardrails'
     1  #!/usr/bin/env bash
     2  # terraform show -json の出力を標準入力で受け取り、
     3  # delete を含む変更（削除、作り直し）があれば止める
     4  set -euo pipefail
     5
     6  json=$(cat)
     7
     8  printf '%s\n' "$json" | jq -r '
     9    .resource_changes[]?
    10    | select(.change.actions != ["no-op"])
    11    | select(.change.actions | index("delete") | not)
    12    | "PASS  \(.address) actions=\(.change.actions | join(","))"'
    13
    14  blocked=$(printf '%s\n' "$json" | jq -r '
    15    .resource_changes[]?
    16    | select(.change.actions | index("delete"))
    17    | "BLOCK \(.address) actions=\(.change.actions | join(",")) reason=\(.action_reason // "-")"')
    18
    19  if [ -n "$blocked" ]; then
    20    printf '%s\n' "$blocked"
    21    echo "policy: blocked ($(printf '%s\n' "$blocked" | grep -c .))"
    22    exit 1
    23  fi
    24  echo "policy: pass"
syntax_exit_code=0
[gitops09-guardrails c4f9b36] GitOps第9回: planから削除と作り直しを検知するスクリプトを追加
 1 file changed, 24 insertions(+)
 create mode 100755 .github/scripts/plan-policy.sh
c4f9b36 (HEAD -> gitops09-guardrails) GitOps第9回: planから削除と作り直しを検知するスクリプトを追加
53c8be1 (origin/main, main) Merge pull request #44 from juehara-crypto/gitops09-tf-baseline
```

このコミットは、まだプッシュしていません。パイプラインへの組み込みは、**[セクション6](#6-パイプラインに組み込んで止まる場所を確かめる)** で行います。

### ■ 検証内容：7つのplanに判定をかける

**[セクション4](#4-planのjsonから変更の種類を取り出す)** と同じ6つの変更と、変更のない状態の、計7つのplanを作り直します。`main.tf`は、そのつど元に戻します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
mkdir -m 700 ~/gitops09-plans
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-base" > /dev/null); echo "base plan_exit_code=$?"

sed -i '/^  image    = docker_image.ansible_target.image_id$/a\  env      = each.key == "target-node1" ? ["APP_ENV=production"] : []' main.tf
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-env" > /dev/null); echo "env plan_exit_code=$?"
git restore main.tf

sed -i '/^    "target-node3" = 2223$/a\    "target-node4" = 2224' main.tf
sed -i '/^    "target-node3" = \[docker_network.lab_net.name\]$/a\    "target-node4" = [docker_network.lab_net.name]' main.tf
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-add" > /dev/null); echo "add plan_exit_code=$?"
git restore main.tf

sed -i '/^    "target-node3" = 2223$/d' main.tf
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-del" > /dev/null); echo "del plan_exit_code=$?"
git restore main.tf

sed -i '/^  image    = docker_image.ansible_target.image_id$/a\  env      = each.key == "target-node1" ? ["APP_ENV=production"] : []' main.tf
sed -i '/^  lifecycle {$/a\    create_before_destroy = true' main.tf
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-cbd" > /dev/null); echo "cbd plan_exit_code=$?"
git restore main.tf

(umask 077; terraform plan -input=false -replace=tls_private_key.generated -out="$HOME/gitops09-plans/tfplan-key" > /dev/null); echo "key plan_exit_code=$?"

sed -i '/^  name = "ansible-lab-net"$/a\  ipam_config {\n    subnet = "172.19.0.0/16"\n  }' main.tf
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-net" > /dev/null); echo "net plan_exit_code=$?"
git restore main.tf

git status --short; echo "git_status_exit_code=$?"
```

**▼ 実行結果**

```plaintext
base plan_exit_code=0
env plan_exit_code=0
add plan_exit_code=0
del plan_exit_code=0
cbd plan_exit_code=0
key plan_exit_code=0
net plan_exit_code=0
git_status_exit_code=0
```

7つのplanに、判定のスクリプトをかけます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
for p in base env add del cbd key net; do
  echo "== $p"
  terraform show -json "$HOME/gitops09-plans/tfplan-$p" | ../.github/scripts/plan-policy.sh
  echo "exit_code=$?"
done
```

**▼ 実行結果**

```plaintext
== base
policy: pass
exit_code=0
== env
BLOCK docker_container.targets["target-node1"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
exit_code=1
== add
PASS  docker_container.targets["target-node4"] actions=create
policy: pass
exit_code=0
== del
BLOCK docker_container.targets["target-node3"] actions=delete reason=delete_because_each_key
policy: blocked (1)
exit_code=1
== cbd
BLOCK docker_container.targets["target-node1"] actions=create,delete reason=replace_because_cannot_update
policy: blocked (1)
exit_code=1
== key
BLOCK docker_container.targets["target-node1"] actions=delete,create reason=replace_because_cannot_update
BLOCK docker_container.targets["target-node2"] actions=delete,create reason=replace_because_cannot_update
BLOCK docker_container.targets["target-node3"] actions=delete,create reason=replace_because_cannot_update
BLOCK tls_private_key.generated actions=delete,create reason=replace_by_request
policy: blocked (4)
exit_code=1
== net
BLOCK docker_network.lab_net actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
exit_code=1
```

確認に使ったplanファイルを削除し、終了時点の状態を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
rm -rf ~/gitops09-plans
ls -d ~/gitops09-plans; echo "exit_code=$?"
git status --short; echo "git_status_exit_code=$?"
git log --oneline -2
cd terraform
terraform plan -detailed-exitcode > /dev/null 2>&1; echo "plan_exit_code=$?"
```

**▼ 実行結果**

```plaintext
ls: cannot access '/home/control/gitops09-plans': No such file or directory
exit_code=2
git_status_exit_code=0
c4f9b36 (HEAD -> gitops09-guardrails) GitOps第9回: planから削除と作り直しを検知するスクリプトを追加
53c8be1 (origin/main, main) Merge pull request #44 from juehara-crypto/gitops09-tf-baseline
plan_exit_code=0
```

### ■ 結果

7つのplanの判定を、**[セクション4](#4-planのjsonから変更の種類を取り出す)** の第49回の条件での件数と並べると、次のとおりです。

|plan|変更|この回の判定|第49回の条件での件数|
|---|---|---|---|
|`base`|変更なし|通す（`exit_code=0`）|0|
|`env`|target-node1に環境変数を追加|止める（1件）|1|
|`add`|target-node4を追加|通す（`PASS`が1件）|0|
|`del`|target-node3を外す|止める（1件）|0|
|`cbd`|`create_before_destroy`と環境変数の追加|止める（1件）|0|
|`key`|鍵の作り直し|止める（4件）|3|
|`net`|`lab_net`にサブネットを明示|止める（1件）|0|

第49回の条件では0件だった削除、順序を逆にした作り直し、ネットワークの作り直しが、すべて止める側に入りました。通したのは、変更のないplanと、コンテナを1台加えるだけのplanです。`add`では、通す変更も`PASS`として表示され、何が変わるかを判定の結果と一緒に読めます。

止めたplanでは、どのアドレスが、どの変更の種類と理由で止まったかが出力されます。`key`では、作り直しを指定した鍵そのものに加えて、参照によって巻き込まれたコンテナ3台が、それぞれ1行ずつ並びました。`for_each`で作ったコンテナも、インスタンスごとに区別して出力されています。

一方で、この判定には、止めすぎと、見えないものの両方があります。

* **止めすぎ**：コンテナに関係しないリソースの削除や作り直しも、すべて止める。たとえば、コンテナにつながっていないリソースを削除するだけの変更も、明示的な許可が必要になる。リソースの種類で絞らなかった代わりに、止めてから人が判断する変更が増える
* **見えないもの**：判定が見ているのは、planの`actions`までである。`["update"]`として計画される変更が、コンテナの中の状態に何をするかは見ていない。また、**[セクション2](#2-terraformのチェックは2層ある)** で整理したとおり、Ansibleで入れた設定が失われることは、作り直しや削除から推定しているにすぎない
* **判定そのものの置き場所**：スクリプトは`.github/scripts/`にあり、ワークフローのファイルと同じく、パスの判定ではTerraformの変更にもAnsibleの変更にも当たらない。**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** のセクション7で整理した、ワークフローのファイルはガードレールの対象にならないという限界は、このスクリプトにも当てはまる

ここまでの判定は、手元で作ったplanに対して実行しただけです。次のセクションでは、この判定と静的なチェックをパイプラインに組み込み、承認待ちとして保存したplanそのものを、承認ゲートの入口で評価します。

---

[↑ 目次に戻る](#-目次)

---

## 6. パイプラインに組み込んで、止まる場所を確かめる

ここまでで、4つの静的なチェック（`fmt -check`・`validate`・tflint・Trivy）と、planの判定のスクリプトがそろいました。このセクションでは、これらを **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** から使っているパイプラインに組み込み、性質の違う4つの変更を流して、どこで止まり、どこを通るのかを確かめます。

|変更|想定|
|---|---|
|ワークフローとスクリプトだけの変更|ガードレールは動かない|
|出力値を1つ足す（害のない変更）|すべて通って、適用まで進む|
|整形の崩れたコード|静的なチェックで失敗し、入口で止まる|
|コンテナの作り直しになる変更|静的なチェックは通り、planの判定で止まる。許可すれば進む|

### 組み込む前に、判定できない入力を止める

**[セクション5](#5-再生成を含むplanを検知する)** で作ったスクリプトは、空の入力を受け取ると`policy: pass`を返していました。パイプラインの中で`terraform show -json`が何も出力せずに終わった場合、判定は「止めるものがない」となり、そのまま適用に進んでしまいます。判定できないものは、通さずに止めるべきです。

#### ■ 検証内容

最初は、`jq -e '.format_version'`の終了コードで判定しようとしました。ところが、検証環境のjq（1.6）では、空の入力に対して`jq -e`が`0`を返し、空の入力を見分けられませんでした。

**実行コマンド**

```plaintext
jq --version
printf '' | jq -e '.format_version' > /dev/null 2>&1; echo "jq_exit_code=$?"
```

**▼ 実行結果**

```plaintext
jq-1.6
jq_exit_code=0
```

そこで、`.format_version`の値を文字列として取り出し、空かどうかで判定する形に変えました。planのJSONには必ず`format_version`があるので、値が取れないものは、planのJSONではないと見なします。変更後のスクリプトの先頭部分は次のとおりです。

**実行コマンド**

```plaintext
sed -n '6,12p' .github/scripts/plan-policy.sh | cat -n
```

**▼ 実行結果**

```plaintext
     1  json=$(cat)
     2
     3  fv=$(printf '%s\n' "$json" | jq -r '.format_version // empty' 2>/dev/null || true)
     4  if [ -z "$fv" ]; then
     5    echo "policy: error (input is not a terraform plan JSON)"
     6    exit 2
     7  fi
```

空の入力、JSONではない入力、中身のないJSON（`{}`）の3つと、**[セクション5](#5-再生成を含むplanを検知する)** で使った2つのplan（変更なし、鍵の作り直し）で確かめます。

**実行コマンド**

```plaintext
printf '' | .github/scripts/plan-policy.sh; echo "exit_code=$?"
echo 'not json' | .github/scripts/plan-policy.sh; echo "exit_code=$?"
echo '{}' | .github/scripts/plan-policy.sh; echo "exit_code=$?"
cd terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
mkdir -m 700 ~/gitops09-plans
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-base" > /dev/null); echo "plan_exit_code=$?"
terraform show -json "$HOME/gitops09-plans/tfplan-base" | ../.github/scripts/plan-policy.sh; echo "exit_code=$?"
(umask 077; terraform plan -input=false -replace=tls_private_key.generated -out="$HOME/gitops09-plans/tfplan-key" > /dev/null); echo "plan_exit_code=$?"
terraform show -json "$HOME/gitops09-plans/tfplan-key" | ../.github/scripts/plan-policy.sh; echo "exit_code=$?"
rm -rf ~/gitops09-plans
cd ..
```

**▼ 実行結果**

```plaintext
policy: error (input is not a terraform plan JSON)
exit_code=2
policy: error (input is not a terraform plan JSON)
exit_code=2
policy: error (input is not a terraform plan JSON)
exit_code=2
plan_exit_code=0
policy: pass
exit_code=0
plan_exit_code=0
BLOCK docker_container.targets["target-node1"] actions=delete,create reason=replace_because_cannot_update
BLOCK docker_container.targets["target-node2"] actions=delete,create reason=replace_because_cannot_update
BLOCK docker_container.targets["target-node3"] actions=delete,create reason=replace_because_cannot_update
BLOCK tls_private_key.generated actions=delete,create reason=replace_by_request
policy: blocked (4)
exit_code=1
```

#### ■ 結果

判定できない3つの入力はすべて`policy: error`・`2`で止まり、planのJSONは **[セクション5](#5-再生成を含むplanを検知する)** と同じ結果になりました。終了コードの意味は、`0`が通す、`1`が止める（削除や作り直しがある）、`2`が判定できない、の3つです。

### ワークフローに組み込む

ワークフローへの変更は、次の4点です。

|ファイル|変更|
|---|---|
|`gitops-pipeline.yml`|ジョブ`terraform-static`を追加（`terraform/`が変わったときだけ、4つの静的なチェックをステップごとに実行）|
|`gitops-pipeline.yml`|承認待ちを記録するジョブ`record-pending`で、planのハッシュ値を表示|
|`gitops-apply.yml`|入力`allow_destroy`を追加。入口（`verify`ジョブ）に、静的なチェックの結果の確認と、planの判定を追加（判定に必要な`terraform init`のステップも追加）|
|`gitops-apply.yml`|適用するジョブ`terraform-apply`で、適用の直前にplanのハッシュ値を表示|

ハッシュ値は、記録した時点・判定した時点・適用した時点の3か所で、同じplanのファイルを扱っていることをログで示すためのものです。

静的なチェックのジョブは次のとおりです。ステップを分けておくと、どのチェックで失敗したのかが、ジョブの画面でそのまま分かります。

```yaml
  terraform-static:
    needs: changes
    if: needs.changes.outputs.terraform == 'true'
    runs-on: [self-hosted, Linux, X64]
    steps:
      - uses: actions/checkout@v4
      - name: Terraform init
        working-directory: terraform
        run: terraform init -input=false -lockfile=readonly
      - name: Terraform fmt
        working-directory: terraform
        run: terraform fmt -check -recursive
      - name: Terraform validate
        working-directory: terraform
        run: terraform validate -no-color
      - name: TFLint
        working-directory: terraform
        run: tflint
      - name: Trivy (terraform)
        working-directory: terraform
        run: trivy config --misconfig-scanners terraform --exit-code 1 .
```

入口に追加したのは、次の3つのステップです。

```yaml
      - name: Check terraform guardrail results
        if: steps.pending.outputs.terraform == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          conclusion=$(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/check-runs?check_name=terraform-static" \
            | jq -r '[.check_runs[] | select(.app.slug == "github-actions")] | sort_by(.started_at) | last | .conclusion // "missing"')
          echo "terraform-static: $conclusion"
          if [ "$conclusion" != "success" ]; then
            echo "::error::terraform-static on $GITHUB_SHA is $conclusion"
            exit 1
          fi
      - name: Terraform init
        if: steps.pending.outputs.terraform == 'true'
        working-directory: terraform
        run: terraform init -input=false -lockfile=readonly
      - name: Check plan policy
        if: steps.pending.outputs.terraform == 'true'
        working-directory: terraform
        env:
          ALLOW_DESTROY: ${{ inputs.allow_destroy }}
        run: |
          sha256sum "$HOME/gitops-pending/tfplan"
          rc=0
          terraform show -json "$HOME/gitops-pending/tfplan" | ../.github/scripts/plan-policy.sh || rc=$?
          if [ "$rc" -eq 0 ]; then
            exit 0
          fi
          if [ "$rc" -eq 1 ] && [ "$ALLOW_DESTROY" = "true" ]; then
            echo "::warning::delete or replace is allowed by allow_destroy"
            exit 0
          fi
          if [ "$rc" -eq 1 ]; then
            echo "::error::plan contains delete or replace; dispatch again with allow_destroy to apply it"
            exit 1
          fi
          echo "::error::plan policy check failed (exit code $rc)"
          exit 1
```

1つ目は、静的なチェックの結果を確かめるステップです。**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** でansible-lintとMoleculeの結果を確かめたのと同じ方法で、適用しようとしているコミットに付いた`terraform-static`の結果を、GitHubのAPIで読み取ります。

3つ目が、planの判定です。`allow_destroy`が付いていないときは、削除や作り直しを含むplanをここで止めます。`allow_destroy`が付いているときは、同じ判定結果を表示したうえで警告を出し、適用に進みます。判定できない入力（終了コード`2`）は、`allow_destroy`があっても止めます。

`allow_destroy`は、手動で実行するときに選ぶ入力として、次のように定義しました。実行の画面では、`description`に書いた日本語が表示されます。

```yaml
      allow_destroy:
        description: '削除と作り直しを含むplanの適用を許可する'
        type: boolean
        default: false
```

この変更を、プルリクエスト`#45`で出しました。変わったのは`.github/`の下の3ファイルだけなので、確認の実行（「GitOps Pipeline」の`#81`）とマージの実行（`#82`）では、パスの判定が`terraform=false`、`***=false`になり、`changes`以外のジョブはすべてスキップされました。追加した`terraform-static`も動いていません。`***`は、**[セクション3](#3-静的チェックの効き目はプロバイダーで変わる)** で説明したとおり、`ansible`が伏せられたものです。

**▼ 実行結果（「GitOps Pipeline」の実行`#81`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
.github/scripts/plan-policy.sh
.github/workflows/gitops-apply.yml
.github/workflows/gitops-pipeline.yml
base=53c8be1a743b8a4bc536f12c4286eb6ad3ca250a
terraform=false
***=false
```

**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** と同じく、ワークフローとスクリプト自身の変更は、この回のガードレールの対象外です。ガードレールを書き換える変更は、ガードレールでは止まりません。

### 害のない変更は、そのまま適用まで進む

最初に、削除も作り直しも起きない変更を流します。題材は、`target-node`がつながっているネットワークの名前を、出力値として1つ足す変更です。リソースには何も起きず、出力値が1つ増えるだけです。

#### ■ 検証内容

まず、手元で4つの静的なチェックとplanの判定を通します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops09-tf-output
cat >> terraform/outputs.tf <<'EOF'

output "lab_network_name" {
  value = docker_network.lab_net.name
}
EOF
cd terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform fmt -check -recursive; echo "fmt_exit_code=$?"
terraform validate -no-color; echo "validate_exit_code=$?"
tflint; echo "tflint_exit_code=$?"
trivy config --quiet --misconfig-scanners terraform --exit-code 1 .; echo "trivy_exit_code=$?"
mkdir -m 700 ~/gitops09-plans
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-output" > /dev/null); echo "plan_exit_code=$?"
terraform show -json "$HOME/gitops09-plans/tfplan-output" | jq -c '.output_changes | with_entries(.value = .value.actions)'
terraform show -json "$HOME/gitops09-plans/tfplan-output" | ../.github/scripts/plan-policy.sh; echo "exit_code=$?"
rm -rf ~/gitops09-plans
cd ..
```

**▼ 実行結果**

```plaintext
fmt_exit_code=0
Success! The configuration is valid.

validate_exit_code=0
tflint_exit_code=0
（途中省略：Trivyの表）
trivy_exit_code=0
plan_exit_code=0
{"generated_private_key":["no-op"],"lab_network_name":["create"],"target_nodes":["no-op"],"target_nodes_ips":["no-op"]}
policy: pass
exit_code=0
```

出力値の`lab_network_name`だけが`["create"]`で、判定は`policy: pass`です。スクリプトが見るのはリソースの変更（`resource_changes`）だけなので、出力値の変更では`PASS`の行も出ません。

これをプルリクエスト`#46`で出すと、確認の実行（`#83`）で、`terraform-static`が初めて動き、4つのステップがすべて成功しました。マージの実行（`#84`）では、承認待ちが記録され、そのplanのハッシュ値が表示されます。

**▼ 実行結果（「GitOps Pipeline」の実行`#84`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
-rw------- 1 control control 14928 Oct  9 05:54 tfplan
b85cd1901de34744c14f1547d398d5cef5329945c198ade7e3750243733eaaae  tfplan
base=9688329b636542188da3b6ba86a68196b2cda655
commit=3de8b3d9c9a88c41a611371fe8204eeccf0e57f4
terraform=true
***=false
```

この承認待ちを、「GitOps Apply」を2つの入力を外したまま起動して適用しました。次の画像は、その実行`#15`です。

![GitOps Applyの実行#15。verify、terraform-apply、ansible-apply、clear-pendingが成功し、discardはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/section6-tf-output-apply-run.png)

**▼ 実行結果（「GitOps Apply」の実行`#15`、`verify`ジョブのステップ「Check terraform guardrail results」から抜粋）**

```plaintext
terraform-static: success
```

**▼ 実行結果（「GitOps Apply」の実行`#15`、`verify`ジョブのステップ「Check plan policy」から抜粋）**

```plaintext
b85cd1901de34744c14f1547d398d5cef5329945c198ade7e3750243733eaaae  /home/control/gitops-pending/tfplan
policy: pass
```

**▼ 実行結果（「GitOps Apply」の実行`#15`、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）**

```plaintext
b85cd1901de34744c14f1547d398d5cef5329945c198ade7e3750243733eaaae  /home/control/gitops-pending/tfplan

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

Outputs:

generated_private_key = <sensitive>
lab_network_name = "***-lab-net"
（途中省略：ほかの出力値）
```

#### ■ 結果

静的なチェックの結果の確認、planの判定、適用の3つがすべて通りました。ハッシュ値は、記録（`#84`）・判定・適用の3か所で`b85cd190...`のまま一致していて、判定したplanと適用したplanが同じファイルであることが分かります。`lab_network_name`の値が`***-lab-net`と表示されているのは、`ansible-lab-net`の`ansible`が伏せられたためです。

### 整形の崩れは、入口で止まる

次は、静的なチェックで失敗する変更です。先ほどの出力値に説明（`description`）を足しますが、`=`の位置をそろえずに書きます。`terraform fmt`は`=`の位置をそろえる整形をするので、`fmt -check`が失敗します。

#### ■ 検証内容

まず、手元で確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops09-tf-fmt
sed -i '/^  value = docker_network.lab_net.name$/a\  description = "target-nodeがつながっているネットワークの名前"' terraform/outputs.tf
cd terraform
terraform fmt -check -recursive; echo "fmt_exit_code=$?"
terraform fmt -diff -recursive -write=false
terraform validate -no-color; echo "validate_exit_code=$?"
cd ..
```

**▼ 実行結果**

```plaintext
outputs.tf
fmt_exit_code=3
outputs.tf
--- old/outputs.tf
+++ new/outputs.tf
@@ -16,6 +16,6 @@
 }

 output "lab_network_name" {
-  value = docker_network.lab_net.name
+  value       = docker_network.lab_net.name
   description = "target-nodeがつながっているネットワークの名前"
 }
Success! The configuration is valid.

validate_exit_code=0
```

文法は正しく（`validate`は`0`）、整形だけが崩れています。手元で引っかかることは分かっていますが、ここでは直さずに、プルリクエスト`#47`で出しました。

確認の実行（`#85`）は、`terraform-static`が「Terraform fmt」で失敗し、実行全体がFailureになりました。そのあとの`validate`・TFLint・Trivyのステップは実行されていません。一方、planを作る`terraform-plan`と、Ansibleのチェックモードの`ansible-check`は成功しています。

![GitOps Pipelineの実行#85。terraform-staticだけが失敗し、terraform-planとansible-checkは成功、record-pendingはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/section6-tf-fmt-pr-run.png)

**▼ 実行結果（「GitOps Pipeline」の実行`#85`、`terraform-static`ジョブのステップ「Terraform fmt」から抜粋）**

```plaintext
outputs.tf
Error: Process completed with exit code 3.
```

このときプルリクエストの画面では、`terraform-static`に失敗の印が付いていましたが、マージのボタンは押せる状態でした。この検証環境は、GitHubの無料プランの非公開リポジトリで、失敗したチェックがあるとマージできないようにする設定（ブランチ保護）が使えないためです。そこで、あえてマージしました。

マージの実行（`#86`）でも`terraform-static`は失敗しましたが、承認待ちは記録されました。次の画像のジョブの図のとおり、承認待ちを記録する`record-pending`は`ansible-check`のあとにつながっていて、`terraform-static`とはつながっていないためです。

![GitOps Pipelineの実行#86。terraform-staticは失敗しているが、record-pendingは成功している](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/section6-tf-fmt-merge-run.png)

**▼ 実行結果（「GitOps Pipeline」の実行`#86`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
ab476dff133357bb5fdad8eb8e274f61861695bb92896de6a176e41a73462a5e  tfplan
base=3de8b3d9c9a88c41a611371fe8204eeccf0e57f4
commit=01830f47e4e1dd94381c3d4af54a06e8478203b9
terraform=true
***=false
```

静的なチェックは失敗したのに、適用を待つplanはできている状態です。ここで「GitOps Apply」を、2つの入力を外したまま起動しました（実行`#16`）。

**▼ 実行結果（「GitOps Apply」の実行`#16`、`verify`ジョブのステップ「Check terraform guardrail results」から抜粋）**

```plaintext
terraform-static: failure
Error: terraform-static on 01830f47e4e1dd94381c3d4af54a06e8478203b9 is failure
Error: Process completed with exit code 1.
```

入口の`verify`が、適用しようとしているコミット`01830f4`の`terraform-static`の結果（`failure`）を読み取って止めました。そのあとの「Terraform init」と「Check plan policy」は実行されず、`terraform-apply`・`ansible-apply`、承認待ちを消す`clear-pending`もスキップされました。承認待ちは消えずに残ります。

止まった承認待ちは、「GitOps Apply」を「承認待ちを適用せずに破棄する」にチェックを入れて起動し、破棄しました（実行`#17`）。そのうえで、`terraform fmt`で整形したプルリクエスト`#48`を出しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git switch -c gitops09-tf-fmt-fix
cd terraform
terraform fmt -recursive
terraform fmt -check -recursive; echo "fmt_exit_code=$?"
cd ..
git --no-pager diff
```

**▼ 実行結果**

```plaintext
outputs.tf
fmt_exit_code=0
diff --git a/terraform/outputs.tf b/terraform/outputs.tf
index 1ad915c..8207746 100644
--- a/terraform/outputs.tf
+++ b/terraform/outputs.tf
@@ -16,6 +16,6 @@ output "generated_private_key" {
 }

 output "lab_network_name" {
-  value = docker_network.lab_net.name
+  value       = docker_network.lab_net.name
   description = "target-nodeがつながっているネットワークの名前"
 }
```

`#48`の確認の実行（`#87`）とマージの実行（`#88`）は、どちらも成功しました。`#88`で記録された承認待ちの`base`は`01830f4`で、破棄した承認待ちの`commit`と同じです。破棄しても、次の承認待ちは、適用されなかった変更をまとめて含む形で作られます。

**▼ 実行結果（「GitOps Pipeline」の実行`#88`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
78b9b6b8df694ed9c2396af8e736e3932d8b672083a96615400e443ab8509c57  tfplan
base=01830f47e4e1dd94381c3d4af54a06e8478203b9
commit=3de296d8da34a14963fcdc767e2ccecc19363bf9
```

「GitOps Apply」の実行`#18`では、`terraform-static: success`、`policy: pass`となり、同じハッシュ値`78b9b6b8...`のplanが適用されました（`0 added, 0 changed, 0 destroyed`）。`description`はリソースを変えないので、適用で起きることはありません。

#### ■ 結果

整形の崩れはプルリクエストの段階で見えていましたが、マージは止められませんでした。止めたのは、マージ後に適用しようとした入口（`#16`）です。チェックを強制する場所を、マージの前から適用の前に移す、という **[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** からの方針どおりに動いています。

### 作り直しは、入口で止まり、許可すれば進む

最後は、コンテナの作り直しになる変更です。**[セクション4](#4-planのjsonから変更の種類を取り出す)** で試したのと同じく、target-node1にだけ環境変数（`env`）を足します。Dockerのコンテナは、環境変数をあとから変えられないので、作り直しになります。

#### ■ 検証内容

`docker_container.targets`は、`for_each`で3台をまとめて作っています。target-node1にだけ付くよう条件式で書き、target-node2・3は`null`（指定なし）にします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git switch -c gitops09-tf-env
sed -i '/^  image    = docker_image.ansible_target.image_id$/a\  env      = each.key == "target-node1" ? ["GITOPS09_ENV=replace-test"] : null' terraform/main.tf
cd terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform fmt -check -recursive; echo "fmt_exit_code=$?"
terraform validate -no-color; echo "validate_exit_code=$?"
tflint; echo "tflint_exit_code=$?"
trivy config --quiet --misconfig-scanners terraform --exit-code 1 .; echo "trivy_exit_code=$?"
mkdir -m 700 ~/gitops09-plans
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-env" > /dev/null); echo "plan_exit_code=$?"
terraform show -no-color "$HOME/gitops09-plans/tfplan-env" | grep -E '^  # |^Plan:'
terraform show -json "$HOME/gitops09-plans/tfplan-env" | ../.github/scripts/plan-policy.sh; echo "exit_code=$?"
rm -rf ~/gitops09-plans
cd ..
```

**▼ 実行結果**

```plaintext
fmt_exit_code=0
Success! The configuration is valid.

validate_exit_code=0
tflint_exit_code=0
（途中省略：Trivyの表）
trivy_exit_code=0
plan_exit_code=0
  # docker_container.targets["target-node1"] must be replaced
Plan: 1 to add, 0 to change, 1 to destroy.
BLOCK docker_container.targets["target-node1"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
exit_code=1
```

4つの静的なチェックはすべて`0`です。静的なチェックから見ると、この変更には何の問題もありません。止めるのはplanの判定だけです。

作り直したことをあとで確かめられるよう、target-node1と、比べるためのtarget-node2の状態を記録しておきます。

**実行コマンド**

```plaintext
for n in target-node1 target-node2; do docker inspect -f '{{.Name}} id={{printf "%.12s" .Id}} created={{.Created}} ip={{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}} env={{json .Config.Env}}' "$n"; done
```

**▼ 実行結果**

```plaintext
/target-node1 id=0a20acc48f6d created=2026-10-07T21:56:06.531849165Z ip=172.19.0.2 env=["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","DEBIAN_FRONTEND=noninteractive"]
/target-node2 id=48305fbf396c created=2026-10-07T21:56:06.517725161Z ip=172.19.0.3 env=["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","DEBIAN_FRONTEND=noninteractive"]
```

これをプルリクエスト`#49`で出しました。確認の実行（`#89`）もマージの実行（`#90`）も、`terraform-static`を含めてすべて成功しています。planの判定は入口でだけ動くので、プルリクエストの段階では止まりません。`#90`で記録された承認待ちのハッシュ値は`a0f2a5d8...`です。

「GitOps Apply」を、2つの入力を外したまま起動しました。次の画像は、その実行`#19`です。

![GitOps Applyの実行#19。verifyが失敗し、terraform-apply、ansible-apply、clear-pendingはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/section6-tf-env-apply-blocked.png)

**▼ 実行結果（「GitOps Apply」の実行`#19`、`verify`ジョブのステップ「Check terraform guardrail results」から抜粋）**

```plaintext
terraform-static: success
```

**▼ 実行結果（「GitOps Apply」の実行`#19`、`verify`ジョブのステップ「Check plan policy」から抜粋）**

```plaintext
a0f2a5d8d3139af5b80f15ce5d3a547f840d3a2a8f483f1d0b3be4b09ff9645a  /home/control/gitops-pending/tfplan
BLOCK docker_container.targets["target-node1"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
Error: plan contains delete or replace; dispatch again with allow_destroy to apply it
Error: Process completed with exit code 1.
```

静的なチェックの結果の確認は通り、planの判定で止まりました。手元で確かめると、承認待ちは同じハッシュ値`a0f2a5d8...`のまま残っています。

この作り直しは意図したものなので、同じ承認待ちを、「GitOps Apply」を「削除と作り直しを含むplanの適用を許可する」にチェックを入れて起動し、適用しました。次の画像は、その実行`#20`です。

![GitOps Applyの実行#20。verify、terraform-apply、ansible-apply、clear-pendingが成功し、discardはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/section6-tf-env-apply-allowed.png)

**▼ 実行結果（「GitOps Apply」の実行`#20`、`verify`ジョブのステップ「Check plan policy」から抜粋）**

```plaintext
a0f2a5d8d3139af5b80f15ce5d3a547f840d3a2a8f483f1d0b3be4b09ff9645a  /home/control/gitops-pending/tfplan
BLOCK docker_container.targets["target-node1"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
Warning: delete or replace is allowed by allow_destroy
```

**▼ 実行結果（「GitOps Apply」の実行`#20`、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）**

```plaintext
a0f2a5d8d3139af5b80f15ce5d3a547f840d3a2a8f483f1d0b3be4b09ff9645a  /home/control/gitops-pending/tfplan
docker_container.targets["target-node1"]: Destroying... [id=0a20acc48f6d935e9ad3f3c59489b252ec8048034f6a830426050b5c4b5c77cd]
docker_container.targets["target-node1"]: Destruction complete after 2s
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node1"]: Creation complete after 1s [id=e72df5533305a760225c3e5884a7f49ea7149ad471d349448ceb3cebb3e26e41]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
（途中省略：Outputsの表示）
```

**▼ 実行結果（「GitOps Apply」の実行`#20`、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、Pythonのインタープリターに関する警告）
TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
ok: [target-node3]
ok: [target-node2]
--- before
+++ after: /etc/drift-check-target.conf
@@ -0,0 +1 @@
+monitored_by=***-drift-check

changed: [target-node1]

TASK [疎通確認] ****************************************************************
ok: [target-node2]
ok: [target-node1]
ok: [target-node3]

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

手元で、作り直したあとの状態を確かめます。

**実行コマンド**

```plaintext
for n in target-node1 target-node2; do docker inspect -f '{{.Name}} id={{printf "%.12s" .Id}} created={{.Created}} ip={{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}} env={{json .Config.Env}}' "$n"; done
```

**▼ 実行結果**

```plaintext
/target-node1 id=e72df5533305 created=2026-10-09T07:48:36.172908111Z ip=172.19.0.2 env=["GITOPS09_ENV=replace-test","PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","DEBIAN_FRONTEND=noninteractive"]
/target-node2 id=48305fbf396c created=2026-10-07T21:56:06.517725161Z ip=172.19.0.3 env=["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","DEBIAN_FRONTEND=noninteractive"]
```

#### ■ 結果

`#19`と`#20`は、同じplan（`a0f2a5d8...`）に同じ判定結果（`policy: blocked (1)`）が出ていて、違いは`allow_destroy`の有無だけです。止めるか進めるかを、判定ではなく、人が起動するときの入力で決めています。

作り直されたtarget-node1は、IDと作成日時が変わり、`GITOPS09_ENV`が加わりました。target-node2は変わっていません。IPアドレスは同じ172.19.0.2が割り当てられましたが、作り直しでは変わることもあります。インベントリはTerraformの出力値から作っているので、変わっても追随します。

作り直しで、Ansibleが入れた設定ファイルも消えました。`terraform/`が変わったときは`ansible-apply`が全体を実行するので、消えた設定はtarget-node1にだけ入れ直されています（`changed=1`）。作り直しを許可するときは、Terraformの適用だけで終わらず、Ansibleで設定を入れ直すところまでが1回の適用になります。

### 元に戻すときの落とし穴

target-node1を元に戻すため、足した`env`の行を消すプルリクエストを作ろうとしたところ、想定と違う結果になりました。

#### ■ 検証内容

`env`の行を消して、planと判定を確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git switch -c gitops09-tf-env-revert
sed -i '/^  env      = each.key == "target-node1" ? \["GITOPS09_ENV=replace-test"\] : null$/d' terraform/main.tf
cd terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
mkdir -m 700 ~/gitops09-plans
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-revert" > /dev/null); echo "plan_exit_code=$?"
terraform show -no-color "$HOME/gitops09-plans/tfplan-revert" | grep -E '^  # |^Plan:'
terraform show -json "$HOME/gitops09-plans/tfplan-revert" | ../.github/scripts/plan-policy.sh; echo "exit_code=$?"
rm -rf ~/gitops09-plans
cd ..
```

**▼ 実行結果**

```plaintext
plan_exit_code=0
policy: pass
exit_code=0
```

planに変更がなく（`grep`で何も出ない）、判定は`policy: pass`です。設定から`env`を消しても、target-node1は元に戻らず、`GITOPS09_ENV=replace-test`が残ったままになります。

理由を、プロバイダーの定義（スキーマ）とtfstateで確かめます。

**実行コマンド**

```plaintext
cd terraform
terraform providers schema -json | jq -c '.provider_schemas[].resource_schemas.docker_container.block.attributes.env | {optional, computed}'
for n in target-node1 target-node2; do echo "== $n"; terraform state show -no-color "docker_container.targets[\"$n\"]" | grep -A 3 -E '^ +env +='; done
cd ..
```

**▼ 実行結果**

```plaintext
{"optional":null,"computed":null}
{"optional":true,"computed":true}
== target-node1
    env                                         = [
        "GITOPS09_ENV=replace-test",
    ]
    hostname                                    = "e72df5533305"
== target-node2
    env                                         = []
    group_add                                   = []
    hostname                                    = "48305fbf396c"
    id                                          = "48305fbf396cfe7eba119faec6a4f664eaa325a4295fbde7612b71d8820873a7"
```

1行目は、`docker_container`を持たないもう1つのプロバイダー（`tls`）の分です。Dockerプロバイダーの`env`は、`optional`と`computed`がどちらも`true`です。書いてもよく（optional）、書かなければプロバイダーが値を決める（computed）属性なので、書かないことは「空にする」ではなく「何も指定しない」と扱われ、tfstateにある今の値がそのまま使われます。

そこで、行を消す代わりに、`env = []`と空であることを明示しました。

**実行コマンド**

```plaintext
sed -i '/^  image    = docker_image.ansible_target.image_id$/a\  env      = []' terraform/main.tf
git --no-pager diff main -- terraform/main.tf
cd terraform
mkdir -m 700 ~/gitops09-plans
(umask 077; terraform plan -input=false -out="$HOME/gitops09-plans/tfplan-revert" > /dev/null); echo "plan_exit_code=$?"
terraform show -no-color "$HOME/gitops09-plans/tfplan-revert" | grep -E '^  # |^Plan:'
terraform show -json "$HOME/gitops09-plans/tfplan-revert" | ../.github/scripts/plan-policy.sh; echo "exit_code=$?"
rm -rf ~/gitops09-plans
cd ..
```

**▼ 実行結果**

```plaintext
diff --git a/terraform/main.tf b/terraform/main.tf
index ab01322..a8395d4 100644
--- a/terraform/main.tf
+++ b/terraform/main.tf
@@ -92,7 +92,7 @@ resource "docker_container" "targets" {
   for_each = local.target_nodes
   name     = each.key
   image    = docker_image.ansible_target.image_id
-  env      = each.key == "target-node1" ? ["GITOPS09_ENV=replace-test"] : null
+  env      = []
   dynamic "networks_advanced" {
     for_each = local.target_node_networks[each.key]
     content {
plan_exit_code=0
  # docker_container.targets["target-node1"] must be replaced
Plan: 1 to add, 0 to change, 1 to destroy.
BLOCK docker_container.targets["target-node1"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
exit_code=1
```

target-node2・3はtfstateがもともと`[]`なので、`env = []`と書いても変わらず、作り直しになるのはtarget-node1だけです。元に戻す変更も作り直しなので、planの判定で止まります。止まることは`#19`で確かめたので、プルリクエスト`#50`をマージしたあと、「GitOps Apply」は最初から「削除と作り直しを含むplanの適用を許可する」にチェックを入れて起動しました（実行`#21`）。

**▼ 実行結果（「GitOps Apply」の実行`#21`、`verify`ジョブのステップ「Check plan policy」から抜粋）**

```plaintext
665360df3c3c28009c40690ca2ec029a012c22be437a906c633b82d32d3afd5c  /home/control/gitops-pending/tfplan
BLOCK docker_container.targets["target-node1"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
Warning: delete or replace is allowed by allow_destroy
```

**▼ 実行結果（「GitOps Apply」の実行`#21`、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）**

```plaintext
665360df3c3c28009c40690ca2ec029a012c22be437a906c633b82d32d3afd5c  /home/control/gitops-pending/tfplan
docker_container.targets["target-node1"]: Destroying... [id=e72df5533305a760225c3e5884a7f49ea7149ad471d349448ceb3cebb3e26e41]
docker_container.targets["target-node1"]: Destruction complete after 2s
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node1"]: Creation complete after 3s [id=2ae67f98c3817ec4854878743c2f78dc6ae44072719880c863545422ac4f7515]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
（途中省略：Outputsの表示）
```

Ansibleは、`#20`と同じく、target-node1にだけ設定を入れ直しました（`changed=1`、target-node2・3は`changed=0`）。最後に、手元でコンテナの状態と、コードと実際の状態がそろっていることを確かめます。`-detailed-exitcode`は、変更がなければ`0`、あれば`2`を返すオプションです。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
for n in target-node1 target-node2; do docker inspect -f '{{.Name}} id={{printf "%.12s" .Id}} created={{.Created}} ip={{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}} env={{json .Config.Env}}' "$n"; done
cd terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform plan -input=false -detailed-exitcode -no-color > /dev/null; echo "plan_exit_code=$?"
cd ..
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えと、オブジェクトの受信の表示）
/target-node1 id=2ae67f98c381 created=2026-10-09T08:29:13.976390323Z ip=172.19.0.2 env=["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","DEBIAN_FRONTEND=noninteractive"]
/target-node2 id=48305fbf396c created=2026-10-07T21:56:06.517725161Z ip=172.19.0.3 env=["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","DEBIAN_FRONTEND=noninteractive"]
plan_exit_code=0
```

#### ■ 結果

target-node1は3度目のID（`2ae67f98c381`）になり、`GITOPS09_ENV`が消えました。target-node2は最初から変わっていません。コードと実際の状態もそろっています（`plan_exit_code=0`）。

|時点|target-node1のID|`GITOPS09_ENV`|
|---|---|---|
|`env`を足す前|`0a20acc48f6d`|なし|
|「GitOps Apply」の実行`#20`のあと|`e72df5533305`|`replace-test`|
|「GitOps Apply」の実行`#21`のあと|`2ae67f98c381`|なし|

Terraformでは、設定の行を消すことと、値を空にすることが、同じ意味になるとは限りません。`optional`と`computed`の両方を持つ属性は、行を消しても「指定なし」になるだけで、今の値が残ります。元に戻すつもりの変更でplanに差分が出ないときは、その属性がこの種類でないかを疑い、空の値を明示します。

コードには`env = []`が残りますが、「環境変数は空にする」という意図が読めるので、このままにしています。

---

[↑ 目次に戻る](#-目次)

---

## 7. クラウドプロバイダーではガードレールの価値が上がる

この回の検証は、Dockerプロバイダーで行いました。**[セクション3](#3-静的チェックの効き目はプロバイダーで変わる)** で見たとおり、Dockerプロバイダーのコードでは、静的なチェックが見つけたのはtflintの1件（`terraform_required_version`）だけで、TrivyのTerraformのコードへの指摘は0件でした。この結果だけを見ると、ガードレールは手間のわりに効き目が小さく見えます。

ただ、これはDockerプロバイダーの性質によるところが大きく、クラウドプロバイダーでは事情が変わります。

### 静的なチェックは、クラウドのほうが見つけるものが多い

**[セクション3](#3-静的チェックの効き目はプロバイダーで変わる)** でAWSのリソースを書いた最小のコードを調べると、AWS向けのルールセットを加えたtflintは存在しないインスタンスタイプ（`t3.micr0`）を見つけ、Trivyは3件（AWS-0028、AWS-0107、AWS-0131）を指摘しました。

|チェック|Dockerプロバイダーのコード|AWSの最小のコード|
|---|---|---|
|tflint|1件（`terraform_required_version`）|1件（`aws_instance_invalid_type`）|
|Trivy（Terraformのコード）|0件|3件|

差が出る理由は、チェックツールが持っているルールの量です。Trivyのセキュリティ設定のルールや、tflintのプロバイダー別のルールセットは、主要なクラウドのリソースを対象に作られています。Dockerプロバイダーには、そもそも当てはまるルールがほとんどありません。

クラウドでは、公開範囲の広すぎる通信の許可や、暗号化していないディスクのように、書き間違い1つがそのまま外部からの攻撃面や情報漏えいにつながる設定があります。静的なチェックは、そうした設定をplanを作る前の段階で止めます。この回の`terraform-static`のジョブと入口の確認は、プロバイダーを変えても、ルールが増えるだけで、そのまま使えます。

### 作り直しの重さが、クラウドでは桁違いになる

**[セクション6](#6-パイプラインに組み込んで止まる場所を確かめる)** では、target-node1の作り直しを許可して適用しました。消えたのはAnsibleが入れた設定ファイル1つだけで、それもAnsibleが入れ直しました。コンテナの作り直しは数秒で終わり、IPアドレスも同じものが割り当てられています。

クラウドのリソースでは、同じ「作り直し」でも失うものが大きくなります。

|作り直しで起きること|この回の検証（Docker）|クラウドで起きうること|
|---|---|---|
|データ|設定ファイル1つが消え、Ansibleで戻せた|データベースやディスクの中身が消え、構成管理では戻せない|
|時間|数秒|数分〜数十分の停止|
|接続先|IPアドレスは同じだった|アドレスや接続先の名前が変わり、つながっている側の設定も直す必要がある|
|費用|なし|作り直しのあいだ、新旧の両方に課金されることがある|

しかも、どの属性の変更が作り直しになるかは、プロバイダーとリソースの種類ごとに決まっていて、コードの差分だけでは分かりません。**[セクション6](#6-パイプラインに組み込んで止まる場所を確かめる)** の環境変数のように、見た目は1行の追加でも、planを作って初めて作り直しだと分かります。**[セクション4](#4-planのjsonから変更の種類を取り出す)** で見た`action_reason`の`replace_because_cannot_update`は、まさにこの「その場では変えられないので作り直す」という意味です。

この回のplanの判定は、リソースの種類を問わず、`actions`に`delete`を含むかどうかだけを見ています。そのため、どのクラウドのどのリソースでも、作り直しと削除は入口で一度止まり、`allow_destroy`を付けた人の判断を経てからでないと適用されません。

### 元に戻す変更が、元に戻らないことがある

**[セクション6](#6-パイプラインに組み込んで止まる場所を確かめる)** の最後では、`env`の行を消しても、planに差分が出ませんでした。`optional`と`computed`の両方を持つ属性は、書かなければ「指定なし」として今の値が使われるためです。

クラウドのリソースには、この種類の属性が多くあります。作成時に既定値が入り、あとからは書いた分だけを管理する、というものです。設定を消せば元に戻るつもりでマージしても、planは`no-op`になり、判定も通り、何も起きません。ガードレールが止めなかったことは、元に戻ったことを意味しません。

元に戻す変更を出すときは、planに意図した差分が出ているかを、判定の結果とは別に確かめる必要があります。この回のスクリプトが通す変更も`PASS`の行で表示しているのは、止めなかったものも目で確かめられるようにするためです。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

* Terraformのガードレールは、コードに対する静的なチェックと、planに対するポリシーのチェックの2層に分けられる。静的なチェック（`fmt -check`・`validate`・tflint・Trivy）は、書かれたコードの形と設定の値を見て、planを作る前に止める。planのチェックは、stateと実際の環境を突き合わせた結果、適用で何が起きるかを見て止める。作り直しや削除は、コードの差分だけでは分からず、planを作って初めて分かるため、後者の層でしか止められない
* 静的なチェックの効き目は、プロバイダーで大きく変わることを実機で確認した。Dockerプロバイダーのコードでは、tflintの指摘は`terraform_required_version`の1件、TrivyのTerraformのコードへの指摘は0件だった。AWSの最小のコードを調べると、AWS向けのルールセットを加えたtflintは存在しないインスタンスタイプを、Trivyは3件の設定を指摘した。ルールの多くが主要なクラウドのリソースを対象に作られているためで、Dockerプロバイダーで効き目が小さいことは、チェックの価値が小さいことを意味しない
* planのJSON（`terraform show -json`）の`resource_changes`にある`actions`と`action_reason`から、変更の種類を取り出せる。作り直しは`["delete","create"]`、`create_before_destroy`を付けた作り直しは`["create","delete"]`、削除は`["delete"]`で表れ、理由は`replace_because_cannot_update`や`delete_because_each_key`のように示される。Ansible×Terraformシリーズの **[第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)** の条件（コンテナの`["delete","create"]`だけを数える）では、ノードの削除、`create_before_destroy`を付けた作り直し、ネットワークの作り直しの3つを取りこぼすことを実機で確認した
* 作り直しと削除を見つけるスクリプトは、`actions`に`delete`を含む変更を、リソースの種類を問わず止める形にした。終了コードは、`0`が通す、`1`が止める、`2`が判定できない、の3つで、空の入力やplanのJSONではない入力は、通さずに`2`で止める。検証環境のjq 1.6では、空の入力に対して`jq -e`が`0`を返したため、`format_version`の値を取り出して空かどうかで判定した
* 静的なチェックを`terraform-static`のジョブとしてパイプラインに組み込み、承認ゲートの入口に、適用するコミットの`terraform-static`の結果の確認と、承認待ちのplanの判定を加えた。整形の崩れたコードは、チェックが失敗したままマージでき、承認待ちも記録されたが、入口で止まった。作り直しになる変更は、静的なチェックをすべて通り、planの判定だけが入口で止めた。害のない変更は、すべてを通って適用まで進んだ
* planのハッシュ値を、承認待ちの記録・入口での判定・適用の3か所で表示し、判定したplanと適用したplanが同じファイルであることを、すべての適用で確認した。止まった承認待ちは消えずに残り、破棄した場合も、次の承認待ちは適用されなかった変更をまとめて含む形で作られた
* 作り直しを適用するときは、手動の起動の入力`allow_destroy`で人が許可する。同じplanに同じ判定結果が出て、`allow_destroy`の有無だけで止まるか進むかが分かれることを実機で確認した。作り直しで消えた設定は、`terraform/`の変更で全体を実行する`ansible-apply`が入れ直し、作り直されたノードだけが`changed`になった。`allow_destroy`はplan全体に対する許可で、1つのplanに含まれる作り直しと削除を、まとめて許可することになる
* Dockerプロバイダーの`env`は、`optional`と`computed`の両方を持つ属性で、設定の行を消してもplanは`no-op`になり、判定も通り、何も起きなかった。`env = []`と空であることを明示して、初めて元に戻せた。ガードレールが止めなかったことは、意図した変更が起きたことを意味しない
* ワークフローとスクリプト自身の変更は、この回のガードレールの対象外で、ガードレールを書き換える変更は、ガードレールでは止まらない。また、planの判定は入口でだけ動くため、プルリクエストの段階では、作り直しを含む変更も成功として表示される
* クラウドプロバイダーでは、静的なチェックが見つける設定が増え、作り直しで失うもの（データ、時間、接続先、費用）も大きくなる。planの判定はプロバイダーに依存しない`actions`だけを見ているため、この回の構成は、プロバイダーを変えてもそのまま使える

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

本シリーズの **[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** では、Ansibleの側に、ansible-lintとMoleculeをガードレールとして置きました。第9回となる今回は、同じ考え方で、Terraformの側にもガードレールを置きました。コードに対する静的なチェックと、planに対するポリシーのチェックの2層を整理し、静的なチェックの効き目がプロバイダーで大きく変わることを、DockerプロバイダーとAWSの最小のコードで、実機で比べました。planのJSONから作り直しと削除を取り出すスクリプトを作り、パイプラインに組み込んで、整形の崩れたコードと作り直しになる変更が、承認ゲートの入口でそれぞれ止まることを確認しました。作り直しは`allow_destroy`で人が許可して適用し、消えた設定をAnsibleが入れ直すところまでを確かめました。元に戻す変更でplanに差分が出ないという落とし穴も、実機で確認しました。

ここまでで、AnsibleとTerraformの両側に、人の承認の手前で機械的に止めるガードレールがそろいました。ただし、この回までのパイプラインは、操作対象が1つの環境だけであることを前提にしています。承認待ちも、`allow_destroy`の判断も、tfstateも、1組しかありません。実際の運用では、開発用の環境で試した変更を、検証用の環境、本番の環境へと順に広げていきます。そのとき、同じ作り直しでも、開発用の環境なら許してよく、本番の環境では慎重に扱いたい、という違いが出てきます。

**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** では、複数の環境（dev/stg/prod）へのデプロイを分岐させます。環境をブランチではなく、mainの1本と環境ごとのディレクトリで分け、tfstate・インベントリ・承認を環境ごとに分けます。そのうえで、環境を順に上げていく昇格の順序と条件をワークフローで強制し、それぞれの環境に「最後に適用したコミット」を記録する仕組みを導入します。

**[次回：第10回：複数環境（dev/stg/prod）へのデプロイを分岐させる](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)　｜　[次の記事：【GitOps編】第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第2部まとめブログ：GitOpsパイプラインで「見たものだけが、承認したときだけ届く」仕組みを積み上げる** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 10. 連載一覧：「Ansible×TerraformをGitOpsで回す」

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