---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第12回：失敗したパイプラインをどう診断するか'
description: 'GitHub Actionsで組んだAnsibleとTerraformのパイプラインの失敗を、GitHub Actions・ガードレール・Terraform・Ansibleの4つの層に分けて整理する。第2部で積み上げた仕組みが意図して止める「設計どおりの停止」と「故障」を切り分け、self-hostedランナーの停止で失敗と表示されないまま待ち続けるジョブや、デバッグ出力がジョブのログに残すものを実機で確かめる。第2部の最終回として、第2部で作った仕組み全体を振り返る。'
pubDate: 2026-10-14
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'GitHub Actions', 'トラブルシューティング']
seriesId: 'ansible-gitops-part2'
seriesNo: 12
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/'
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
2. [失敗を4つの層に分ける](#2-失敗を4つの層に分ける)
3. [設計どおりの停止か故障か](#3-設計どおりの停止か故障か)
4. [self-hostedランナー特有の症状](#4-self-hostedランナー特有の症状)
5. [ログはどこに残るか](#5-ログはどこに残るか)
6. [前シリーズのデバッグの知識を持ち込む](#6-前シリーズのデバッグの知識を持ち込む)
7. [クラウドでも4層の切り分けは変わらない](#7-クラウドでも4層の切り分けは変わらない)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#10-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

AnsibleとTerraformのパイプラインをGitHub Actionsで運用していて、

* パイプラインの実行が、失敗と表示された
* 失敗したのだから、どこかが壊れている
* よって、エラーメッセージを読んで、壊れたところを直せばよい

と考えていないでしょうか。

CIの失敗の診断を扱う記事の多くは、ジョブのログの読み方や、デバッグ出力の有効化を中心にしています。パイプラインが意図して止めている失敗と、故障による失敗を、どう見分けるかは、あまり扱われていません。承認やチェックの仕組みを積み上げたパイプラインを運用し始めると、次のような場面にぶつかります。

* `Error acquiring the state lock`で止まったのを故障と思い込み、ロックを強制的に解除しようとした
* 適用の入口で止まったので、通すためにチェックのステップを外した
* ジョブが待機したまま進まないのに、失敗としては表示されない
* 原因を調べるためにデバッグ出力を有効にしたら、ジョブのログに接続先や設定の値がそのまま残っていた
* パイプラインはすべて成功したのに、インフラには残りものがあった

これらは、エラーメッセージの読み方や、ログの量の問題に見えます。共通しているのは、パイプラインが止まったときに、それがどの層で起きたことで、意図して止めたものなのかどうかが、失敗という表示からは分からない点です。そして、成功という表示も、インフラが正しい状態にあることまでは示さない点です。

失敗の原因を特定する手法は、**[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）の第3部](https://qiita.com/juehara-crypto/items/880dbb044c39d2d448cc)** で扱いました。**[Ansible×Terraformシリーズ第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** では、Terraformの`local-exec`から実行したAnsibleが失敗すると、Ansibleの出力は失われないものの、通常のログと`Error: local-exec provisioner error`のブロックの2か所に重複して現れ、罫線で囲まれた`exit status 2`のほうが目立つため、`fatal:`の行が見つけにくくなることを確認しました。そのうえで、`ANSIBLE_LOG_PATH`でAnsibleのログを分離し、時系列で突き合わせる手順を整理しています。**[Ansible×Terraformシリーズ第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** では、`--ask-become-pass`を付けて`local-exec`から実行すると、エラーを出さずにパスワードの入力待ちのまま止まり続けることを確認しました。**[Ansible×Terraformシリーズ第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)** では、`TF_LOG`は`DEBUG`と`TRACE`で記録される情報の階層が異なること、Ansibleは`-vvv`の時点でSSHの接続から権限の昇格までがほぼ出尽くすことを確かめ、デバッグフラグは原因の特定における万能の手段ではないと整理しました。これらの回は、手元から`terraform apply`を実行し、その中からAnsibleを呼び出す構成で、起きてしまった失敗の原因をどう特定するかを扱ったものです。パイプラインが意図して止める仕組みを持つ構成で、止まったことそのものをどう読むかは扱っていません。

本シリーズの第2部では、パイプラインを止める仕組みを、1回ごとに積み上げてきました。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** では、変更されたパスでジョブを切り替え、Terraformのジョブが失敗したときはAnsibleのジョブを動かさない条件を組みました。同じ回では、インベントリを読み込めないまま、Ansibleが1台にも接続せずにジョブが成功と表示される状態と、依存先のジョブのスキップによってAnsibleのジョブまで黙ってスキップされる状態も確認しています。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** では、Terraformのstateロックとパイプラインの直列化を組み合わせ、手元の`terraform apply`がロックを持っている間は、パイプラインの`terraform plan`が`Error acquiring the state lock`で止まることを確認しました。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、適用を手動の起動に分け、その入口で、mainからの起動か、承認待ちのplanを作ったコミットか、プルリクエストを通ったコミットかを確かめて、外れれば止める承認ゲートを組みました。保存したplanは、前提のtfstateが変わると`Saved plan is stale`で止まります。**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** と **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** では、AnsibleとTerraformの両側のチェックの結果と、planの判定を、承認ゲートの入口で確かめ、通らない変更を止めました。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** では、前の環境に適用し終えていないコミットを、次の環境に適用させない昇格の順序を加えました。

一方、本シリーズの **[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** では、反対の場面を確認しています。`git revert`で取り消した変更は、パイプラインのどの段階でも止まらずに成功し、「最後に適用したコミット」として記録されましたが、インフラには取り消したはずのユーザーやファイルが残っていました。同じ回の次回予告では、止まったときに、それが設計どおりの停止なのか故障なのかを見分けられなければ、ガードレールは「よく止まる邪魔なもの」になってしまうとして、その切り分けをこの回に送っています。

第12回となる今回は、第2部の最終回として、ここまでに組んだパイプラインが止まったときに、どこを見ればよいかを整理します。まず、パイプラインの失敗を、GitHub Actions・ガードレール・Terraform・Ansibleの4つの層に分け、第5〜11回で実際に出たメッセージを層ごとに並べて、第2部で作った仕組み全体の索引にします。次に、同じ「失敗」の表示になる、設計どおりの停止と故障を、止まったジョブとステップ、メッセージから見分けられるかを実機で確かめます。そのうえで、self-hostedランナーに特有の症状として、失敗と表示されないまま進まなくなる場合と、ランナーのホストに残ったものが影響する場合を確かめます。さらに、TerraformとAnsibleの出力がどこに残り、デバッグ出力を有効にすると何がジョブのログに残るかを確認し、Ansible×Terraformシリーズ第3部の知識を、ジョブを分けたこのパイプラインにどう持ち込めるかを整理します。最後に、この切り分けがクラウドのプロバイダーでも変わらないことを示し、第2部で作った仕組みを振り返ります。

正確に言うと、**仕組みを積み上げたパイプラインでは、止まることの多くは故障ではなく、ガードレールが仕事をした結果です。診断の最初の一歩は、エラーメッセージを読み解くことではなく、どの層で、設計どおりに止まったのかを見分けることです**。この回で扱う問いは、「パイプラインが止まったとき、それは故障なのか、ガードレールが働いたのか。どこを見れば見分けられるのか」です。

次のセクションでは、パイプラインの失敗を4つの層に分けて整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 失敗を4つの層に分ける

第2部で組んだパイプラインの失敗を、GitHub Actions・ガードレール・Terraform・Ansibleの4つの層に分け、第5〜11回で実際に出たメッセージを層ごとに整理します。

### 4つの層と、実行が通る順序

パイプラインの1回の実行は、次の順に4つの層を通ります。

```
【GitHub Actions層】ジョブを、いつ、どこで、どの順に動かすか
　↓
【ガードレール層】その変更を、インフラに届けてよいか
　↓
【Terraform層】リソースを、計画どおりに作り、変えるか
　↓
【Ansible層】操作対象に接続し、設定を入れるか
```

|層|この層が決めること|第2部で組んだもの|
|---|---|---|
|GitHub Actions層|ワークフローを起動するか、どのジョブを動かすか、ジョブの順序、同時に動く実行の扱い、ジョブを動かすランナー|パスによるジョブの切り替えと、Terraformのジョブが失敗したときにAnsibleのジョブを止める条件（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**）、`concurrency`による直列化（**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**）|
|ガードレール層|その変更をインフラに届けてよいか|承認ゲートの入口の確認（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）、ansible-lintとMolecule（**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**）、Terraformの静的なチェックとplanの判定（**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**）、昇格の順序（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**）|
|Terraform層|`terraform init`・`plan`・`apply`が、tfstateとプロバイダーを相手に動くか|tfstateのpgバックエンドとstateロック（**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**）、保存したplanの適用（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）|
|Ansible層|`ansible-playbook`が、操作対象に接続し、権限を上げ、タスクを実行できるか|実行時のインベントリと鍵の用意（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**）|

層は、使っているツールではなく、その処理の役割で分けています。たとえば、ガードレール層のplanの判定は`terraform show -json`を使いますが、確かめているのは「この変更を届けてよいか」なので、Terraform層ではなくガードレール層に入れます。

### 層は、止まったステップで決まる

ワークフローのジョブと層は、1対1には対応しません。1つのジョブの中に、複数の層のステップが入っているためです。

|ワークフロー|ジョブ|含まれる層（ステップ）|
|---|---|---|
|「GitOps Pipeline」|`changes`|GitHub Actions層（変更されたパスの判定）|
|「GitOps Pipeline」|`ansible-lint`、`molecule`、`terraform-static`|ガードレール層|
|「GitOps Pipeline」|`terraform-plan`|Terraform層|
|「GitOps Pipeline」|`ansible-check`|Terraform層（`terraform init`と、鍵の書き出しの`terraform output`）、Ansible層（確認モード）|
|「GitOps Pipeline」|`record-pending`|GitHub Actions層（承認待ちの記録）|
|「GitOps Apply」|`verify`|ガードレール層（入口の確認）、Terraform層（planの判定の前の`terraform init`）|
|「GitOps Apply」|`terraform-apply`|Terraform層|
|「GitOps Apply」|`ansible-apply`|Terraform層（`terraform init`と、鍵の書き出しの`terraform output`）、Ansible層（本実行）|
|「GitOps Apply」|`record-applied`|GitHub Actions層（適用の記録と、承認待ちの削除）|

たとえば、`ansible-apply`ジョブが失敗しても、止まったのがステップ「Write private key from tfstate」であれば、`terraform output`が動かなかったTerraform層の問題で、Ansibleはまだ動いていません。どの層で止まったかは、ジョブの名前ではなく、止まったステップで判断します。

### 層ごとのメッセージ

第5〜11回で実際に出たメッセージを、層ごとに並べます。表の`<コミット>`、`<環境>`のところには、実際のログではコミットのハッシュ値や環境の名前が入ります。長いメッセージは、見分けに使う先頭の部分だけを載せ、後ろを`…`で省いています。また、実際のログでは、`ansible`という語が`***`に伏せられています（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション5）。

**GitHub Actions層**

|回|表示・メッセージ|出た場所|意味|
|---|---|---|---|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**|`ansible-check`が「skipped」のまま、実行全体は「Success」|「GitOps Pipeline」の実行#10|依存先の`terraform-plan`がスキップされ、`needs`でつないだ後のジョブも黙ってスキップされた。後に条件式で直した|
|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**|`changes`以外のジョブがすべて「skipped」|「GitOps Pipeline」の実行#73など|ワークフローのファイルだけの変更で、`terraform/`にも`ansible/`にも変更がないと判定された|
|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**|実行が「Cancelled」で、どのジョブも動いていない|「GitOps Pipeline」の実行#38|`concurrency`の既定の動きで、待機していた実行が、後から来た実行に置き換えられて取り消された。後に`queue: max`で直した|
|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**|実行の所要時間が、同じ内容の実行より長い|「GitOps Pipeline」の実行#36、#39|同じグループの実行が終わるまで、待機してから動いた|

**ガードレール層**

|回|表示・メッセージ|出た場所|意味|
|---|---|---|---|
|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**|`not started from main`|「GitOps Apply」の実行#6、`verify`ジョブのステップ「Check branch」|main以外のブランチから起動された|
|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**|`<コミット> is not a merge of …`|「GitOps Apply」の実行#4、#5、`verify`ジョブのステップ「Check commits came from pull requests」|プルリクエストを通らずにmainに入ったコミットが、適用の範囲に含まれている|
|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|`no pending approval for <環境>`|「GitOps Apply」の実行#26、#27、`verify`ジョブのステップ「Read pending approval」|その環境の承認待ちがない（使い終えた後にもう一度起動した）|
|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|`<コミット> has not been applied …`|「GitOps Apply」の実行#28、`verify`ジョブのステップ「Check promotion order」|前の環境に、同じコミットをまだ適用していない|
|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**|`no-changed-when: …`|「GitOps Pipeline」の実行#72、#75、#76、`ansible-lint`ジョブ|`changed_when`のない`shell`のタスクがある|
|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**|`ansible-lint on … is failure`、`molecule on … is skipped`|「GitOps Apply」の実行#11、`verify`ジョブのステップ「Check guardrail results」|適用しようとしたコミットで、ansible-lintが失敗し、Moleculeは動いていない|
|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**|`exit code 3`|「GitOps Pipeline」の実行#85、#86、`terraform-static`ジョブのステップ「Terraform fmt」|コードの整形が崩れている|
|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**|`terraform-static on … is failure`|「GitOps Apply」の実行#16、`verify`ジョブのステップ「Check terraform guardrail results」|適用しようとしたコミットで、Terraformの静的なチェックが失敗している|
|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|`plan contains delete or replace; …`|「GitOps Apply」の実行#19、#32、#33、`verify`ジョブのステップ「Check plan policy」|承認待ちのplanに、削除か作り直しが含まれている|
|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**〜**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**|`delete or replace is allowed …`（警告で通過）|「GitOps Apply」の実行#31、#39、#42、#57（dev）、#20、#21、#34、#35（`allow_destroy`）|削除か作り直しを含むが、devであるか、`allow_destroy`で許可されたため通した|
|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|`danger detected: …`|「E2E Provisioning Test」の実行#16〜#19、ステップ「Check for dangerous destroy-and-create actions」|鍵の作り直しをわざと起こし、コンテナの作り直しを検出して止まることを確かめるテスト|

**Terraform層**

|回|表示・メッセージ|出た場所|意味|
|---|---|---|---|
|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**|`Error acquiring the state lock`|「GitOps Pipeline」の実行#26、`terraform-plan`ジョブのステップ「Terraform plan」|手元の`terraform apply`がstateロックを持っていた|
|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**|`Error: Saved plan is stale`|「GitOps Apply」の実行#2、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」|承認待ちのplanを作った後に、別の操作でtfstateが変わった|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**|`Error: Unsupported block type`、`Error: Invalid block definition`|「GitOps Pipeline」の実行#15、`terraform-plan`ジョブのステップ「Terraform init」|`.tf`ファイルの文法の誤り|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**|`Error: Required plugins are not installed`|ジョブと同じ条件の手元（チェックアウト先の`terraform/`）|初期化していない場所で`terraform output`を実行した|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**|`Error: Provider dependency changes detected`|ジョブと同じ条件の手元（複製したリポジトリ）|`-lockfile=readonly`で初期化したが、ロックファイルが設定と合っていない|

**Ansible層**

|回|表示・メッセージ|出た場所|意味|
|---|---|---|---|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**|`skipping: no hosts matched`（ジョブは「Success」）|「Runtime Inventory Check」の実行#1、ステップ「Ansible check mode」|インベントリが空で、Ansibleは1台にも接続していない。後に`unparsed_is_failed`で失敗するように直した|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**|`ERROR! No inventory was parsed, …`|「Runtime Inventory Check」の実行#2、ステップ「Show inventory」|インベントリを読み込めなかった（上の状態を、失敗として見えるようにした後）|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**|`UNREACHABLE!`（`Permissions … are too open.`）|手元の`ansible-playbook`|秘密鍵の権限が広すぎて、SSHがその鍵を使わなかった|
|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|`UNREACHABLE!`（`Permission denied …`）|手元の`ansible`|接続先の`authorized_keys`にない鍵で接続した|
|**[Ansible×Terraformシリーズ第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**|`Missing sudo password`|手元とTerraformの`local-exec`（この検証環境はパスワードなしで権限を上げる設定のため、本シリーズでは出ていない）|権限の昇格にパスワードが要るが、渡されていない|

Ansible層のタスクの失敗（`fatal: … FAILED!`）は、本シリーズの第2部（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** 〜 **[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**）のパイプラインの中では、まだ出ていません。ジョブのログでどう見えるかは、**[セクション6](#6-前シリーズのデバッグの知識を持ち込む)** で確かめます。


### 表から分かること

4つの表を並べると、ガードレール層のメッセージが最も多く、そのほとんどが、第2部で組んだ入口の確認やチェックが出したものです。GitHub Actions層とTerraform層にも、`concurrency`やstateロック、保存したplanのように、意図して止めるために組んだ仕組みのメッセージがあります。

一方、表の中には、失敗ではなく「Success」や「skipped」と表示されたものもあります。依存先のスキップでAnsibleのジョブまで動かなかった実行（「GitOps Pipeline」の実行#10）と、インベントリが空のまま成功した実行（「Runtime Inventory Check」の実行#1）です。どちらも、表示だけを見れば問題のない実行でした。

次のセクションでは、同じ「失敗」の表示になる、設計どおりの停止と故障を、どこで見分けるかを実機で確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 3. 設計どおりの停止か故障か

同じ「失敗」の表示になる、設計どおりの停止と故障を実機で起こし、止まったジョブ、ステップ、メッセージから見分けられるかを確かめます。

**[セクション2](#2-失敗を4つの層に分ける)** の表のメッセージの多くは、第2部で意図して組んだ仕組みが出したものでした。ガードレール層の入口の確認とチェックは、すべてそうです。Terraform層のstateロック（**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**）と保存したplan（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）も、Terraformの仕組みを、止めるために使っています。一方で、どれもジョブの状態は「失敗」になり、故障による失敗と同じ表示になります。

ここでは、次の2つを、同じ流れの中で起こします。

|起こすもの|層|起こし方|
|---|---|---|
|古いplanの拒否（設計どおりの停止）|Terraform層|devに確認用のリソースを足す変更をマージして、承認待ちを作る。承認の前に、手元から同じ変更を先に適用する|
|SSHの接続失敗（故障）|Ansible層|devのコンテナの`authorized_keys`から、パイプラインが使う鍵を一時的に外す|

### ■ 検証内容：承認の前に手元から適用し、古いplanで止める

devの`main.tf`の末尾に、何も作らない`terraform_data`を足します。stgとprodのコードは変えないので、計画に現れるのはdevだけです。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops12-stale-plan
cat >> terraform/envs/dev/main.tf <<'EOF'

resource "terraform_data" "gitops12_stale" {
  input = "v1"
}
EOF
git --no-pager diff
terraform fmt -check -recursive terraform; echo "fmt_exit_code=$?"
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for e in dev stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e plan -input=false -no-color 2>&1 | grep -E '^  # |^Plan:|No changes'; done
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops12-stale-plan'
diff --git a/terraform/envs/dev/main.tf b/terraform/envs/dev/main.tf
index 6a67f07..a660944 100644
--- a/terraform/envs/dev/main.tf
+++ b/terraform/envs/dev/main.tf
@@ -36,3 +36,7 @@ module "lab_env" {
   ansible_user_password = var.ansible_user_password
   operator_public_key   = file("${path.module}/../../id_ed25519.pub")
 }
+
+resource "terraform_data" "gitops12_stale" {
+  input = "v1"
+}
fmt_exit_code=0
== dev
  # terraform_data.gitops12_stale will be created
Plan: 1 to add, 0 to change, 0 to destroy.
== stg
No changes. Your infrastructure matches the configuration.
== prod
No changes. Your infrastructure matches the configuration.
```

この変更をコミットしてプルリクエスト#69を作りました。確認の実行（「GitOps Pipeline」の実行#129）は、`changes`、`terraform-static`、`terraform-plan`、`ansible-check`が成功し、`ansible-lint`、`molecule`、`record-pending`はスキップされました。#69をマージすると（マージコミット`156b773`）、3環境の承認待ちが作られました。

**▼ 実行結果**（「GitOps Pipeline」の実行#130、`record-pending`ジョブのステップ「Record pending approval」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
== dev
（途中省略：ファイルの一覧）
a6688f730e19ad9cc8ab2da690c83cd08ff8abb716317a3ba6e81b62d50c487c  /home/control/gitops-pending/dev/tfplan
commit=156b77317971b6b63f27c75bc8a246eafa5f6170
terraform=true
***=false
== stg
（途中省略：devと同じ形の表示）
== prod
（途中省略：devと同じ形の表示）
```

承認の前に、手元から、devに同じ変更を先に適用します。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション5と同じ操作です。承認待ちのplanには触れません。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
mkdir -p -m 700 ~/gitops12-local
(umask 077; terraform -chdir=terraform/envs/dev plan -input=false -no-color -out="$HOME/gitops12-local/tfplan-local" | grep -E '^  # |^Plan:')
terraform -chdir=terraform/envs/dev apply -input=false -no-color "$HOME/gitops12-local/tfplan-local" | grep -E 'Creation complete|Apply complete'
rm -r ~/gitops12-local
terraform -chdir=terraform/envs/dev state show -no-color terraform_data.gitops12_stale
sha256sum ~/gitops-pending/dev/tfplan
```

**▼ 実行結果**

```plaintext
  # terraform_data.gitops12_stale will be created
Plan: 1 to add, 0 to change, 0 to destroy.
terraform_data.gitops12_stale: Creation complete after 0s [id=5af0ca3f-7db1-b4bb-6947-74d76cadfd38]
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
# terraform_data.gitops12_stale:
resource "terraform_data" "gitops12_stale" {
    id     = "5af0ca3f-7db1-b4bb-6947-74d76cadfd38"
    input  = "v1"
    output = "v1"
}
a6688f730e19ad9cc8ab2da690c83cd08ff8abb716317a3ba6e81b62d50c487c  /home/control/gitops-pending/dev/tfplan
```

devのtfstateは変わり、承認待ちのplanは`a6688f73...`のままです。この状態で、「GitOps Apply」を、ブランチ「main」、環境「dev」で起動しました（実行#70）。起動のときに`allow_destroy`にもチェックを入れていましたが、このplanは作成だけのため、判定には影響していません。

**▼ 実行結果**（「GitOps Apply」の実行#70、`verify`ジョブのステップ「Check plan policy」から抜粋）

```plaintext
a6688f730e19ad9cc8ab2da690c83cd08ff8abb716317a3ba6e81b62d50c487c  /home/control/gitops-pending/dev/tfplan
PASS  terraform_data.gitops12_stale actions=create
policy: pass
```

**▼ 実行結果**（「GitOps Apply」の実行#70、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）

```plaintext
a6688f730e19ad9cc8ab2da690c83cd08ff8abb716317a3ba6e81b62d50c487c  /home/control/gitops-pending/dev/tfplan
╷
│ Error: Saved plan is stale
│
│ The given plan file can no longer be applied because the state was changed
│ by another operation after the plan was created.
╵
Error: Process completed with exit code 1.
```

`verify`は成功し、`terraform-apply`が失敗して、`ansible-apply`と`record-applied`はスキップされました。手元で、承認待ちと記録を確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
ls -l ~/gitops-pending/dev
sha256sum ~/gitops-pending/dev/tfplan
psql "$PG_CONN_STR" -X -c "SELECT id, env, commit_sha FROM gitops.applied WHERE env = 'dev' ORDER BY id DESC LIMIT 1;"
```

**▼ 実行結果**

```plaintext
total 28
-rw------- 1 control control     6 Oct 14 00:33 ansible
-rw------- 1 control control    41 Oct 14 00:33 commit
-rw------- 1 control control     5 Oct 14 00:33 terraform
-rw------- 1 control control 13563 Oct 14 00:32 tfplan
a6688f730e19ad9cc8ab2da690c83cd08ff8abb716317a3ba6e81b62d50c487c  /home/control/gitops-pending/dev/tfplan
 id | env |                commit_sha
----+-----+------------------------------------------
 41 | dev | 945d52c2df1bd52d688b9dbc271e62d4bee23c1a
(1 row)
```

承認待ちは残り、devの「最後に適用したコミット」は`945d52c`のままです。

### ■ 検証内容：パイプラインの鍵を外し、SSHの接続を故障させる

dev-node1の`authorized_keys`には、鍵が2つ入っています。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
docker exec dev-node1 sh -c 'stat -c "%U:%G %a %n" /home/ansible/.ssh/authorized_keys; wc -l < /home/ansible/.ssh/authorized_keys'
docker exec dev-node1 ssh-keygen -lf /home/ansible/.ssh/authorized_keys
ssh-keygen -lf ansible/keys/dev/id_ed25519_generated
ssh-keygen -lf terraform/id_ed25519.pub
```

**▼ 実行結果**

```plaintext
root:root 644 /home/ansible/.ssh/authorized_keys
3
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
256 SHA256:87k/k3EyzFKJxLeqM/s4/9DGamKVfI47ObDuy71yEiQ  (ED25519)
256 SHA256:87k/k3EyzFKJxLeqM/s4/9DGamKVfI47ObDuy71yEiQ  (ED25519)
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
```

`SHA256:87k/...`がパイプラインのAnsibleが使う鍵、`SHA256:Apv1...`が操作する人が手元から接続するための鍵です。行数が3なのは、2つの鍵の間に空行があるためです。行の番号ではなく、パイプラインの鍵の中身に一致する行を外します。元のファイルは、コンテナの中に控えておきます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
docker exec dev-node1 cp /home/ansible/.ssh/authorized_keys /root/authorized_keys.gitops12
KEY=$(ssh-keygen -y -f ansible/keys/dev/id_ed25519_generated | awk '{print $2}')
docker exec dev-node1 sh -c "grep -v -F '$KEY' /root/authorized_keys.gitops12 > /home/ansible/.ssh/authorized_keys"
unset KEY
docker exec dev-node1 ssh-keygen -lf /home/ansible/.ssh/authorized_keys
cd ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
ansible all -i inventories/dev -m ansible.builtin.ping -o 2>/dev/null; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
dev-node1 | UNREACHABLE!: Failed to connect to the host via ssh: @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
（途中省略：ホスト鍵の警告の続き）
Offending ED25519 key in /home/control/.ssh/known_hosts:22
  remove with:
  ssh-keygen -f "/home/control/.ssh/known_hosts" -R "172.20.0.2"
UpdateHostkeys is disabled because the host key is not trusted.
ansible@172.20.0.2: Permission denied (publickey,password).
exit_code=4
```

この状態で、確認用の`terraform_data`を外すブランチを作り、プルリクエスト#70を作りました。devの`main.tf`を、`945d52c`の時点の内容に戻す変更です。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git switch -c gitops12-ssh-fail
git checkout 945d52c -- terraform/envs/dev/main.tf
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform -chdir=terraform/envs/dev plan -input=false -no-color 2>&1 | grep -E '^  # |^Plan:|No changes'
git commit -m "GitOps第12回: devの確認用のterraform_dataを外す"
git push -u origin gitops12-ssh-fail
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えの表示）
  # terraform_data.gitops12_stale will be destroyed
  # (because terraform_data.gitops12_stale is not in configuration)
Plan: 0 to add, 0 to change, 1 to destroy.
（途中省略：コミットとプッシュの表示）
```

確認の実行（「GitOps Pipeline」の実行#131）は、`changes`、`terraform-static`、`terraform-plan`が成功し、`ansible-check`が失敗しました。

**▼ 実行結果**（「GitOps Pipeline」の実行#131、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
== dev

PLAY [接続確認用Playbook] ******************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
fatal: [dev-node1]: UNREACHABLE! => {"changed": false, "msg": "Failed to connect to the host via ssh: @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n（途中省略：ホスト鍵の警告の続き）\r\n***@172.20.0.2: Permission denied (publickey,password).", "unreachable": true}

PLAY RECAP *********************************************************************
dev-node1                  : ok=0    changed=0    unreachable=1    failed=0    skipped=0    rescued=0    ignored=0

Error: Process completed with exit code 4.
```

確認が終わった後、控えておいたファイルから`authorized_keys`を書き戻し、devに接続できることを確かめてから、控えを削除しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
docker exec dev-node1 sh -c 'cat /root/authorized_keys.gitops12 > /home/ansible/.ssh/authorized_keys'
docker exec dev-node1 ssh-keygen -lf /home/ansible/.ssh/authorized_keys
cd ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
ansible all -i inventories/dev -m ansible.builtin.ping -o 2>/dev/null; echo "exit_code=$?"
docker exec dev-node1 rm /root/authorized_keys.gitops12
```

**▼ 実行結果**

```plaintext
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
256 SHA256:87k/k3EyzFKJxLeqM/s4/9DGamKVfI47ObDuy71yEiQ  (ED25519)
dev-node1 | SUCCESS => {（途中省略：Pythonのインタープリターに関する警告）"changed": false,"ping": "pong",（以下省略）}
exit_code=0
```

### ■ 結果

2つの失敗を並べると、次のとおりです。

|項目|古いplanの拒否|SSHの接続失敗|
|---|---|---|
|実行|「GitOps Apply」の実行#70|「GitOps Pipeline」の実行#131|
|止まったジョブとステップ|`terraform-apply`の「Terraform apply (saved plan)」|`ansible-check`の「Ansible check mode」|
|メッセージ|`Error: Saved plan is stale`|`UNREACHABLE!`（`Permission denied (publickey,password).`）|
|層|Terraform層|Ansible層|
|止めたもの|保存したplanの仕組み（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）|どの仕組みでもない。接続そのものができなかった|
|設計どおりか|設計どおりの停止|故障|

どちらも、ジョブの状態は「失敗」で、終了コードは`0`以外でした。失敗という表示だけでは、2つは区別できません。区別できたのは、止まったジョブとステップ、そしてメッセージです。

古いplanの拒否は、`verify`の入口の確認をすべて通った後、保存したplanを適用するステップで止まりました。メッセージは、計画を作った後に別の操作でtfstateが変わったことを、そのまま示しています。これは、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** で、レビューした計画と違う内容を適用しないために組んだ動きです。直すのはパイプラインではありません。承認待ちを破棄し、今のtfstateから計画を作り直して、承認し直すことになります。

SSHの接続失敗は、Terraform層のステップ（初期化と鍵の書き出し）を通った後、Ansibleが接続する段階で止まりました。こちらは、第2部で組んだどの仕組みも、止める理由として持っていない失敗です。直すのは、変更の内容ではなく、接続先の環境です。

SSHの接続失敗のログには、読み分けが必要な点が2つありました。

1つ目は、目立つ警告が、原因ではなかったことです。`msg`の先頭には、`WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!`という大きな警告がありました。dev-node1は **[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** で作り直したため、ホスト鍵が変わり、ランナーのユーザーの`known_hosts`に残った古いホスト鍵と食い違っています。ただし、この検証環境は`ansible.cfg`で`host_key_checking = False`にしているため、この警告では止まらず、接続を続けた後に`Permission denied`で失敗しています。原因は、最後の1行です。

2つ目は、失敗したところで、ステップの残りが実行されていないことです。`ansible-check`のステップは、dev、stg、prodの順に確認モードを実行しますが、ログには`== dev`しかありません。ステップは`bash -e`で動くため、devの失敗でループ全体が止まり、stgとprodの確認は実行されていません。1つの環境の故障は、ほかの環境の確認結果まで隠します。

### ■ 検証内容：マージしても、パイプラインが何もしない

続けて、SSHの接続を戻した後に、プルリクエスト#70をマージしました（マージコミット`cdec03d`）。#70は、#69で足した4行を外す変更です。

マージで起動した「GitOps Pipeline」の実行#132は、`changes`だけが成功し、`ansible-lint`、`molecule`、`terraform-static`、`terraform-plan`、`ansible-check`、`record-pending`はすべてスキップされました。実行全体は成功です。

**▼ 実行結果**（「GitOps Pipeline」の実行#132、`changes`ジョブのステップ「Detect changed paths」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  env:
（途中省略：Secretsの環境変数の表示）
    EVENT_NAME: push
    BASE_SHA: 156b77317971b6b63f27c75bc8a246eafa5f6170
    HEAD_SHA: cdec03dc9920a54128b95e7349d7850eba39094f
last applied (dev): 945d52c2df1bd52d688b9dbc271e62d4bee23c1a
last applied (stg): 945d52c2df1bd52d688b9dbc271e62d4bee23c1a
last applied (prod): 945d52c2df1bd52d688b9dbc271e62d4bee23c1a
terraform=false
***=false
```

手元で、Gitの差分、承認待ち、devのtfstate、3環境の計画を確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git --no-pager diff --stat 945d52c HEAD; echo "diff_exit_code=$?"
for e in dev stg prod; do echo "== $e"; cat ~/gitops-pending/$e/commit; done
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform -chdir=terraform/envs/dev state list | grep gitops12; echo "grep_exit_code=$?"
for e in dev stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e plan -input=false -no-color 2>&1 | grep -E '^  # |^Plan:|No changes'; done
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えと、オブジェクトの受信の表示）
diff_exit_code=0
== dev
156b77317971b6b63f27c75bc8a246eafa5f6170
== stg
156b77317971b6b63f27c75bc8a246eafa5f6170
== prod
156b77317971b6b63f27c75bc8a246eafa5f6170
terraform_data.gitops12_stale
grep_exit_code=0
== dev
  # terraform_data.gitops12_stale will be destroyed
  # (because terraform_data.gitops12_stale is not in configuration)
Plan: 0 to add, 0 to change, 1 to destroy.
== stg
No changes. Your infrastructure matches the configuration.
== prod
No changes. Your infrastructure matches the configuration.
```

承認待ちは`156b773`のまま残っています。この状態で、「GitOps Apply」を、ブランチ「main」、環境「dev」で起動しました（実行#71）。

**▼ 実行結果**（「GitOps Apply」の実行#71、`verify`ジョブのステップ「Read pending approval」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示、ファイルの一覧）
commit=156b77317971b6b63f27c75bc8a246eafa5f6170
terraform=true
***=false
Error: pending plan was made from 156b77317971b6b63f27c75bc8a246eafa5f6170, but main is cdec03dc9920a54128b95e7349d7850eba39094f
Error: Process completed with exit code 1.
```

### ■ 結果

マージの実行#132は、「変更なし」と判定して成功しました。`changes`ジョブは、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** で組んだとおり、各環境に最後に適用したコミットを基準に差分を取ります。3環境とも基準は`945d52c`で、#69で足した4行を#70でそのまま外したため、`945d52c`から`cdec03d`までのファイルの差分は空でした（`diff_exit_code=0`）。判定は、設計どおりに動いています。

それでも、devのtfstateには、手元から作った`terraform_data.gitops12_stale`が残っていて、devの`terraform plan`は削除の計画になります。パイプラインが判定に使う「最後に適用したコミット」には、手元からの適用が入っていないためです。止まりもせず、成功と表示された実行の裏で、devのtfstateとコードは食い違っていました。

この食い違いに最初に引っかかったのは、次に起動した「GitOps Apply」の実行#71でした。承認待ちは`156b773`のまま書き直されず、今のmainの`cdec03d`と一致しないため、ステップ「Read pending approval」で止まりました。この確認は、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** で組んだもので、第2部の検証で実際に止めたのは、これが初めてです。ただし、この確認が知らせているのは、承認待ちとmainのずれです。devのtfstateに残ったリソースを指しているわけではありません。

### ■ 検証内容：後片付け

3環境の承認待ちは、「GitOps Apply」の破棄で片付けました（実行#72がdev、#73がstg、#74がprod）。devに残った`terraform_data.gitops12_stale`は、手元から作ったものなので、同じく手元から削除します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
ls -la ~/gitops-pending
set -a; . ~/.config/tfstate-backend/backend.env; set +a
mkdir -p -m 700 ~/gitops12-local
(umask 077; terraform -chdir=terraform/envs/dev plan -input=false -no-color -out="$HOME/gitops12-local/tfplan-cleanup" | grep -E '^  # |^Plan:')
terraform -chdir=terraform/envs/dev apply -input=false -no-color "$HOME/gitops12-local/tfplan-cleanup" | grep -E 'Destruction complete|Apply complete'
rm -r ~/gitops12-local
for e in dev stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e plan -input=false -detailed-exitcode > /dev/null 2>&1; echo "plan_exit_code=$?"; done
cd ansible
for e in dev stg prod; do echo "== $e"; ansible-playbook -i inventories/$e site.yml --check 2>/dev/null | grep -E ': ok='; done
cd ..
git branch -d gitops12-stale-plan gitops12-ssh-fail
git push origin --delete gitops12-stale-plan gitops12-ssh-fail
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct 14 02:46 .
drwxr-x--- 14 control control 4096 Oct 14 02:49 ..
  # terraform_data.gitops12_stale will be destroyed
  # (because terraform_data.gitops12_stale is not in configuration)
Plan: 0 to add, 0 to change, 1 to destroy.
terraform_data.gitops12_stale: Destruction complete after 0s
Apply complete! Resources: 0 added, 0 changed, 1 destroyed.
== dev
plan_exit_code=0
== stg
plan_exit_code=0
== prod
plan_exit_code=0
== dev
dev-node1                  : ok=5    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== stg
stg-node1                  : ok=5    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== prod
target-node1               : ok=5    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=5    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=5    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
（途中省略：ブランチの削除の表示）
 id | env  |                commit_sha
----+------+------------------------------------------
 43 | prod | 945d52c2df1bd52d688b9dbc271e62d4bee23c1a
 42 | stg  | 945d52c2df1bd52d688b9dbc271e62d4bee23c1a
 41 | dev  | 945d52c2df1bd52d688b9dbc271e62d4bee23c1a
(3 rows)
```

### ■ 結果

承認待ちは空になり、3環境とも`terraform plan`は差分なし、確認モードは5台とも`changed=0`で、この検証を始める前の状態に戻りました。「最後に適用したコミット」は3環境とも`945d52c`のままですが、今のmainの`cdec03d`とのファイルの差分はありません。

### 診断の最初の2つの判断

ここまでの結果から、パイプラインが止まったときの最初の判断は、次の2つに置けます。

1. **どの層で止まったか**：止まったジョブではなく、止まったステップで決める（**[セクション2](#2-失敗を4つの層に分ける)**）
2. **それは設計どおりの停止か**：そのメッセージを出したのが、第2部で組んだ仕組みかどうかで決める

2つ目が「設計どおりの停止」であれば、直すのはパイプラインではありません。直すのは、変更の内容か、止まるまでの手順です。

|止まった理由|この回と第2部の例|直すもの|
|---|---|---|
|設計どおりの停止|`Saved plan is stale`、`pending plan was made from …`、`Error acquiring the state lock`、ガードレール層のメッセージ|変更の内容、または承認待ちの作り直しのような手順|
|故障|`UNREACHABLE!`（`Permission denied …`、`Permissions … are too open.`）、初期化していない場所での`terraform output`|パイプライン、またはランナーや接続先の環境|
|止まらない|変更なしの判定で成功した「GitOps Pipeline」の実行#132、依存先のスキップで成功した「GitOps Pipeline」の実行#10、インベントリが空のまま成功した「Runtime Inventory Check」の実行#1|止まった理由がないので、成功の表示とは別に、インフラの状態を確かめる|

3行目は、止まった理由を探す診断の外にあります。この回の実行#132は、判定のとおりに動き、成功と表示されました。その裏で残っていたのは、手元からの適用でできたリソースです。

### 停止を回避する操作は、ガードレールを壊す

設計どおりの停止を故障と取り違えると、止まった原因を取り除こうとして、止める仕組みそのものを外すことになります。

* `Error acquiring the state lock`を故障と思い込み、ロックを外そうとする。この検証環境のpgバックエンドは`force-unlock`に対応していませんが（**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**）、対応しているバックエンドでは、ロックを持っている実行がまだ動いていても外せてしまう
* planの判定で止まったので、`allow_destroy`を付けて起動し直す。作り直しや削除を、人が確かめずに通すことになる
* 入口の確認で止まったので、ワークフローからそのステップを外す。ワークフローのファイルの変更は、ガードレールの対象にならない（**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**）

この回の検証で、古いplanの拒否も、承認待ちとmainのずれも、きっかけは同じ1つの操作でした。承認の前に、手元から適用したことです。その操作は、設計どおりの停止を2回引き起こし、その間の実行#132を、成功と表示させながら素通りさせました。止まったときに直すべきだったのは、パイプラインではなく、パイプラインの外から適用したという手順です。

次のセクションでは、self-hostedランナーに特有の症状として、失敗と表示されないまま進まなくなる場合を確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 4. self-hostedランナー特有の症状

self-hostedランナーで動かすパイプラインに特有の症状として、ランナーが止まったときのジョブの扱いと、実行をまたいでランナーのホストに残るもの、ホストの環境がジョブに与える影響を、実機で確かめます。

**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で整理したとおり、self-hostedランナーは、操作対象と同じネットワークにあるホストで動き、外向きのHTTPSでGitHubからジョブを受け取ります。ホステッドランナーと違い、ジョブを動かすホストを用意し、動かし続けるのは、使う側の役割です。

### ■ 検証内容：ランナーを止めた状態で、ワークフローを起動する

ランナーのサービスを止めます。

**実行コマンド**

```plaintext
sudo systemctl stop actions.runner.juehara-crypto-ansible-terraform-ci-lab.ubuntu-controller.service
systemctl is-active actions.runner.juehara-crypto-ansible-terraform-ci-lab.ubuntu-controller.service; echo "exit_code=$?"
date -u '+%Y-%m-%dT%H:%M:%SZ'
```

**▼ 実行結果**

```plaintext
inactive
exit_code=3
2026-10-14T04:28:23Z
```

GitHubの画面の「Settings」→「Actions」→「Runners」では、ランナー`ubuntu-controller`の状態が「Offline」と表示されました。

この状態で、「GitOps Apply」を、ブランチ「main」、環境「dev」、承認待ちの破棄にチェックを入れて起動しました（実行#75）。承認待ちは空なので、動けば`discard`ジョブが空のディレクトリを片付けるだけで、インフラには触れません。起動する直前の手元の時刻は`2026-10-14T04:32:05Z`でした。

起動から13分ほどたった時点で、`discard`ジョブを開くと、次のように表示されていました。

```plaintext
Evaluating discard.if
Evaluating: (success() && (inputs.discard_pending))
Expanded: (true && true)
Result: true
Requested labels: self-hosted, Linux, X64
Job defined at: juehara-crypto/ansible-terraform-ci-lab/.github/workflows/gitops-apply.yml@refs/heads/main
Waiting for a runner to pick up this job...
```

次の画像は、起動から15分ほどたった時点の実行#75です。実行全体の「Status」は「Queued」、「Total duration」は空のままで、`discard`ジョブは待機中を示す印のままです。

![GitOps Applyの実行#75。起動から15分たっても、StatusはQueuedのままで、discardジョブは待機中、ほかのジョブはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/section4-runner-offline-queued.png)

ここで、ランナーのサービスを起動しました。

**実行コマンド**

```plaintext
date -u '+%Y-%m-%dT%H:%M:%SZ'
sudo systemctl start actions.runner.juehara-crypto-ansible-terraform-ci-lab.ubuntu-controller.service
systemctl is-active actions.runner.juehara-crypto-ansible-terraform-ci-lab.ubuntu-controller.service; echo "exit_code=$?"
date -u '+%Y-%m-%dT%H:%M:%SZ'
```

**▼ 実行結果**

```plaintext
2026-10-14T04:51:29Z
active
exit_code=0
2026-10-14T04:51:35Z
```

**▼ 実行結果**（「GitOps Apply」の実行#75、`discard`ジョブから抜粋）

```plaintext
2026-10-14T04:51:44.9929783Z Runner name: 'ubuntu-controller'
（途中省略：ジョブの準備の表示）
2026-10-14T04:51:45.3130224Z ref=refs/heads/main sha=cdec03dc9920a54128b95e7349d7850eba39094f environment=dev
（途中省略：実行したスクリプト、シェル、環境変数の表示）
2026-10-14T04:51:45.3721791Z pending approval for dev discarded
```

実行#75は、そのまま「Success」で終わりました。

### ■ 結果

時刻を並べると、次のとおりです。

|時刻（UTC）|起きたこと|
|---|---|
|`04:28:23`|ランナーのサービスが止まっている（画面では「Offline」）|
|`04:32:05`|実行#75を起動する直前|
|起動から約15分後|実行全体は「Queued」、`discard`は`Waiting for a runner to pick up this job...`|
|`04:51:35`|ランナーのサービスを起動|
|`04:51:44`|`discard`ジョブが始まった|
|`04:51:45`|`discard`ジョブが終わり、実行全体は「Success」|

ランナーが止まっていた約19分の間、実行は失敗にならず、「Queued」のまま待ち続けました。ジョブの`if`の条件は評価され、動かすことまでは決まっています。足りないのは、`self-hosted, Linux, X64`のラベルを持つ、動いているランナーだけでした。ランナーを起動すると、9秒ほどで同じジョブが拾われ、成功で終わりました。成功の記録だけを見ると、19分の待ちがあったことは分かりません。

これは、**[セクション2](#2-失敗を4つの層に分ける)** の4つの層のうち、GitHub Actions層で起きていることです。ジョブはまだどのランナーにも渡っていないので、ガードレールもTerraformもAnsibleも、1行も動いていません。ジョブのログもまだなく、画面には待っていることしか表示されません。

**[Ansible×Terraformシリーズ第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** でも、エラーを出さずに止まり続ける場面を確認しました。そちらは、動き始めた`ansible-playbook`のプロセスが、パスワードの入力を待ち続けるもので、`ps`でプロセスを確かめれば手がかりがありました。ランナーが止まっている場合は、ジョブがまだ始まっていないため、パイプラインの側には調べるプロセスもログもありません。確かめる場所は、ランナーの一覧の状態と、ランナーのホストのサービスの状態です。

この症状は、マージで動く「GitOps Pipeline」でも、定期的に動かすワークフローでも同じ形で起きると考えられます（この回では、「GitOps Apply」でだけ確かめています）。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション6で、「唯一の真実」が崩れる経路の1つとして、収束の処理が走らない期間を挙げました。ランナーが止まっていれば、その期間は、誰も気づかないまま延び続けます。待ち続けた実行が、どこまで待った後にどう扱われるかは、この回では確かめていません。検知の処理そのものが止まったことを、別の場所から確かめる仕組みは、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** で扱います。

### ■ 検証内容：実行をまたいで、ランナーのホストに残るもの

ランナーのホストで、実行をまたいで残っているものを確かめます。ランナーの作業ディレクトリ、Moleculeの作業用のディレクトリ（**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**）、ランナーのユーザーの`known_hosts`の3か所です。`known_hosts`は、dev-node1のIPアドレス`172.20.0.2`について、記録されているホスト鍵と、今のdev-node1が返すホスト鍵を比べます。

**実行コマンド**

```plaintext
RUNNER_WS=~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
git -C "$RUNNER_WS" log --oneline -1
git -C "$RUNNER_WS" status --ignored --short --untracked-files=all; echo "git_status_exit_code=$?"
ls -ld ~/.ansible/tmp/molecule.*
ssh-keygen -F 172.20.0.2 -f ~/.ssh/known_hosts | grep -v '^#' | ssh-keygen -lf -
ssh-keyscan -t ed25519 172.20.0.2 2>/dev/null | ssh-keygen -lf -
```

**▼ 実行結果**

```plaintext
cdec03d (HEAD -> main, origin/main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
git_status_exit_code=0
drwxrwxr-x 3 control control 4096 Oct 13 09:40 /home/control/.ansible/tmp/molecule.3cZV.default
drwxrwxr-x 3 control control 4096 Jul 20 05:54 /home/control/.ansible/tmp/molecule.DLh_.default
256 SHA256:vs46dwVtGYtwjwE5De7KgbLdJo3G5QpvwD8/QOyWSqQ |1|5l31+ps191wytaUonruhu+UOhmo=|vgXuMv38I/ZroXxQ6EBF5qQLHLg= (ED25519)
256 SHA256:bhQe+6uASciKskObTVaCI6nH/KPVBGsbY28wah8nBoY 172.20.0.2 (ED25519)
```

作業ディレクトリには、Gitで管理していないファイルは残っていません。そこで、途中で止まったジョブの残りものを模して、作業ディレクトリの`ansible/keys/dev/`に空のファイルを1つ置きます。

**実行コマンド**

```plaintext
RUNNER_WS=~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
mkdir -p "$RUNNER_WS/ansible/keys/dev"
(umask 077; touch "$RUNNER_WS/ansible/keys/dev/gitops12-leftover")
git -C "$RUNNER_WS" status --ignored --short --untracked-files=all
```

**▼ 実行結果**

```plaintext
?? ansible/keys/dev/gitops12-leftover
```

この状態で、「GitOps Apply」を、ブランチ「main」、環境「dev」で起動しました（実行#76）。承認待ちは空なので、`verify`ジョブは、チェックアウトの後に止まります。

**▼ 実行結果**（「GitOps Apply」の実行#76、`verify`ジョブのステップ「Run actions/checkout@v4」とステップ「Read pending approval」から抜粋）

```plaintext
（ステップ「Run actions/checkout@v4」）
（途中省略：入力と環境変数の表示、Gitのバージョンと設定の表示）
Cleaning the repository
[command]/usr/bin/git clean -ffdx
Removing ***/keys/
[command]/usr/bin/git reset --hard HEAD
HEAD is now at cdec03d Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
（途中省略：取得とチェックアウトの表示）
（ステップ「Read pending approval」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
Error: no pending approval for dev
Error: Process completed with exit code 1.
（途中省略：後片付けの表示）
Warning: Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/checkout@v4. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
```

**実行コマンド**

```plaintext
RUNNER_WS=~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
git -C "$RUNNER_WS" status --ignored --short --untracked-files=all; echo "git_status_exit_code=$?"
ls -la "$RUNNER_WS/ansible/keys" 2>&1
```

**▼ 実行結果**

```plaintext
git_status_exit_code=0
ls: cannot access '/home/control/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/ansible/keys': No such file or directory
```

### ■ 結果

作業ディレクトリに置いたファイルは、次の実行のチェックアウトの最初に、`ansible/keys/`ごと削除されました。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** のセクション2で、tfstateが同じ掃除で消えることを確認したのと、同じ動きです。

この掃除は、チェックアウトをするジョブの最初に行われます。前の実行が終わった時点ではなく、次の実行が始まった時点です。前の実行が途中で止まった場合、残りものは、次にチェックアウトをするジョブが動くまで残ります。実行#75の`discard`ジョブのように、チェックアウトをしないジョブでは、掃除は行われません。

パイプラインは、書き出した秘密鍵を、`if: always()`を付けたステップで、ジョブの最後に削除しています（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**）。ジョブの中のステップが失敗した場合でも、この削除は動きます。一方、ジョブの途中でランナーそのものが止まった場合は、このステップが動く機会がなく、秘密鍵は作業ディレクトリに残ると考えられます（この経路は、仕組みからの導出で、実機では確かめていません）。

作業ディレクトリの外にあるものは、掃除の対象になりません。

|場所|残っていたもの|次の実行への影響|
|---|---|---|
|作業ディレクトリ（`_work`の下）|なし（置いた残りものは、次のチェックアウトで削除された）|チェックアウトをするジョブの最初に消える|
|`~/.ansible/tmp/molecule.*`|10月13日と7月の日付のディレクトリ|Moleculeは同じ記録を使い回す（**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**）|
|`~/.ssh/known_hosts`|`172.20.0.2`の古いホスト鍵（`SHA256:vs46...`）。今のdev-node1は`SHA256:bhQe...`|SSHの接続のたびに、ホスト鍵の警告が出る|
|`~/gitops-pending`|承認待ち（今回は空）|承認ゲートが、意図して実行をまたいで残している（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）|

`known_hosts`の古いホスト鍵は、**[セクション3](#3-設計どおりの停止か故障か)** で、SSHの接続失敗のログの先頭に、原因ではない警告として現れたものです。dev-node1は、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** でコンテナを作り直したときに、ホスト鍵が変わりました。IPアドレスは同じまま作り直されたため、ランナーのユーザーの`known_hosts`には、作り直す前のホスト鍵が残っています。この検証環境は`host_key_checking = False`なので接続は止まりませんが、確認を有効にしている環境では、作り直しの後の最初の接続が、この記録で止まることになります。記録はハッシュ化されていて、ファイルを開いても、どのIPアドレスの行かは読めません。

### ランナーのホストの環境が、ジョブの結果を左右する

self-hostedランナーのジョブは、ホストに入れたツールを、そのまま使います。

**実行コマンド**

```plaintext
cat ~/actions-runner/.path
terraform version | head -1
~/ansible-env/bin/ansible --version | head -1
~/ansible-env/bin/ansible-lint --version 2>/dev/null | head -1
~/ansible-env/bin/molecule --version 2>/dev/null | head -1
tflint --version | head -1
trivy --version | head -1
jq --version
psql --version
```

**▼ 実行結果**

```plaintext
/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin
Terraform v1.15.7
ansible [core 2.17.14]
ansible-lint 26.6.0 using ansible-core:2.17.14 ansible-compat:26.6.0 ruamel-yaml:0.19.1 ruamel-yaml-clib:0.2.15
molecule 26.6.0 using python 3.10
TFLint version 0.64.0
Version: 0.75.0
jq-1.6
psql (PostgreSQL) 14.24 (Ubuntu 14.24-0ubuntu0.22.04.1)
```

ランナーのPATH（`.path`）には、Ansibleを入れたPythonの仮想環境が含まれていないため、ワークフローのステップで加えています（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**）。どのバージョンのツールでジョブが動くかは、ワークフローのファイルにもリポジトリにも書かれておらず、ホストに何が入っているかで決まります。

第2部では、ホストのツールに起因する問題に、すでに何度か当たっています。

|回|ホストの環境|起きたこと|
|---|---|---|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**|ランナーのPATHにAnsibleがない|ステップでPATHに加える必要があった|
|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**|ansible-lint 26.6.0が、構文の確認に`ansible-playbook --syntax-check`を使う|`ansible.cfg`の`unparsed_is_failed`と衝突し、`internal-error`になった|
|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**|jq 1.6|空の入力に対して`jq -e`が`0`を返し、判定のスクリプトの書き方を変えた|

ホストのツールを入れ替えると、リポジトリにコミットが1つもないまま、すべてのジョブの動きが変わりえます。その変化は、Gitの履歴にも、パイプラインの実行の記録にも残りません。

実行#76のログの最後にあった`Node.js 20 is deprecated`の警告も、ランナーの環境に関わる表示です。ワークフローが使う`actions/checkout@v4`が想定するNode.js 20ではなく、ランナーが持つNode.js 24で動かされたことを示していて、チェックアウトをするジョブのたびに出ています。ジョブは失敗しておらず、今は警告にとどまっています。ただし、警告が毎回出ていると、ログの最後にある表示を読み飛ばす習慣がつき、本当に読むべき警告を見落とす原因になります。

self-hostedランナーに特有の症状を並べると、次のとおりです。

|症状|層|見る場所|
|---|---|---|
|ランナーが止まっていて、ジョブが待ち続ける|GitHub Actions層|ランナーの一覧の状態、ホストのランナーのサービスの状態|
|前の実行の残りものが、作業ディレクトリに残る|GitHub Actions層|次のチェックアウトの「Cleaning the repository」|
|作業ディレクトリの外に、実行をまたいで残る|残ったものを使う層（例：`known_hosts`ならAnsible層）|ランナーのユーザーのホームディレクトリ|
|ホストのツールのバージョンが、ジョブの結果を変える|そのツールの層|ホストに入っているツールと、そのバージョン|

次のセクションでは、TerraformとAnsibleの出力がどこに残り、デバッグ出力を有効にすると、何がジョブのログに残るかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 5. ログはどこに残るか

パイプラインの中で動いたTerraformとAnsibleの出力が、どこに残り、誰が読めるかを整理します。そのうえで、詳しいデバッグ出力を有効にしたときに、ジョブのログに何が残るかを実機で確かめます。

### 出力の残り場所

第2部のパイプラインでは、TerraformとAnsibleを、ジョブのステップの中で直接実行しています。そのため、両方の出力は、そのままジョブのログになります。

|残る場所|出力|読める人|
|---|---|---|
|GitHubのジョブのログ|`terraform plan`と`terraform apply`の出力、`ansible-playbook`の確認モード（`--check --diff`）と`--diff`付きの本実行の出力|リポジトリを読める人|
|ランナーのホスト|承認待ちのplan（`tfplan`）と、作ったコミットの記録。置き場所は`~/gitops-pending/<環境>/`（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）|ランナーのホストのユーザーだけ（`700`）|
|PostgreSQL|環境ごとに最後に適用したコミット。tfstateと同じデータベースの`gitops.applied`（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**）|データベースに接続できる人|

ジョブのログは、障害を診断するときの、最初の材料です。**[セクション3](#3-設計どおりの停止か故障か)** でも、止まったステップとメッセージは、すべてジョブのログから読み取りました。一方、承認待ちのplanは、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** で、GitHubに上げずにランナーのホストに置くと決めたものです。適用が終われば削除されるので、後から「どの計画を適用したか」を確かめる材料としては残りません。

ジョブのログには、ランナーのホストのディレクトリの構成や、操作対象のIPアドレスが、通常の出力の時点ですでに含まれています。**[セクション3](#3-設計どおりの停止か故障か)** のSSHの接続失敗のログにも、接続先のIPアドレスとランナーのユーザーの`known_hosts`のパスが出ていました。

### ■ 検証内容：デバッグ出力を有効にした確認の実行

原因を調べるために、Terraformの`TF_LOG`と、Ansibleの詳細度（`-vvv`）を有効にした場合に、ジョブのログに何が残るかを確かめます。**[Ansible×Terraformシリーズ第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)** では、`TF_LOG=TRACE`まで上げると、プロバイダーが操作対象とやり取りした内容（コンテナの詳細のJSONなど）が出ること、Ansibleは`-vvv`でSSHの接続から権限の昇格までがほぼ出尽くすことを、手元で確認しました。ここでは、同じ出力が、パイプラインのジョブのログに出た場合を確かめます。

インフラに触れずに済むよう、マージしないプルリクエストの確認の実行だけを使います。プルリクエストの確認の実行は、プルリクエストのブランチのワークフローで動き、承認待ちも作りません。

作業用のブランチで、「GitOps Pipeline」の2つのステップを書き換えます。`terraform-plan`ジョブのステップ「Terraform plan」に`TF_LOG=TRACE`を、`ansible-check`ジョブのステップ「Ansible check mode」に`-vvv`を加えます。どちらも、出力をジョブのログに出しながら、ランナーのホストの`~/gitops12-joblog/`にも書き写します。ジョブのログに出たものを、手元で数えるためです。あわせて、devの`main.tf`の末尾にコメントを1行足し、`terraform/`の変更として、2つのジョブを動かします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops12-debug-log
sed -i 's|^\( *\)terraform -chdir="\$e" plan -input=false$|\1mkdir -p -m 700 "$HOME/gitops12-joblog"; set -o pipefail; TF_LOG=TRACE terraform -chdir="$e" plan -input=false 2>\&1 \| tee "$HOME/gitops12-joblog/terraform-plan-$e.log"|' .github/workflows/gitops-pipeline.yml
sed -i 's|^\( *\)ansible-playbook -i "inventories/\$e" site.yml --check --diff$|\1mkdir -p -m 700 "$HOME/gitops12-joblog"; set -o pipefail; ansible-playbook -i "inventories/$e" site.yml --check --diff -vvv 2>\&1 \| tee "$HOME/gitops12-joblog/ansible-check-$e.log"|' .github/workflows/gitops-pipeline.yml
echo '# GitOps第12回: デバッグ出力の確認用' >> terraform/envs/dev/main.tf
git --no-pager diff
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops12-debug-log'
diff --git a/.github/workflows/gitops-pipeline.yml b/.github/workflows/gitops-pipeline.yml
index dd832a7..a05657f 100644
--- a/.github/workflows/gitops-pipeline.yml
+++ b/.github/workflows/gitops-pipeline.yml
@@ -147,7 +147,7 @@ jobs:
               mkdir -p -m 700 "$HOME/gitops-pending" "$HOME/gitops-pending/$e"
               (umask 077; terraform -chdir="$e" plan -input=false -out="$HOME/gitops-pending/$e/tfplan")
             else
-              terraform -chdir="$e" plan -input=false
+              mkdir -p -m 700 "$HOME/gitops12-joblog"; set -o pipefail; TF_LOG=TRACE terraform -chdir="$e" plan -input=false 2>&1 | tee "$HOME/gitops12-joblog/terraform-plan-$e.log"
             fi
           done

@@ -179,7 +179,7 @@ jobs:
         run: |
           for e in dev stg prod; do
             echo "== $e"
-            ansible-playbook -i "inventories/$e" site.yml --check --diff
+            mkdir -p -m 700 "$HOME/gitops12-joblog"; set -o pipefail; ansible-playbook -i "inventories/$e" site.yml --check --diff -vvv 2>&1 | tee "$HOME/gitops12-joblog/ansible-check-$e.log"
           done
       - name: Remove private keys
         if: always()
diff --git a/terraform/envs/dev/main.tf b/terraform/envs/dev/main.tf
index 6a67f07..5044482 100644
--- a/terraform/envs/dev/main.tf
+++ b/terraform/envs/dev/main.tf
@@ -36,3 +36,4 @@ module "lab_env" {
   ansible_user_password = var.ansible_user_password
   operator_public_key   = file("${path.module}/../../id_ed25519.pub")
 }
+# GitOps第12回: デバッグ出力の確認用
```

コミットしてプルリクエスト#71を作りました。確認の実行（「GitOps Pipeline」の実行#133）は、`changes`、`terraform-static`、`terraform-plan`、`ansible-check`が成功し、`ansible-lint`、`molecule`、`record-pending`はスキップされました。

書き写したファイルの行数を確かめます。

**実行コマンド**

```plaintext
wc -l ~/gitops12-joblog/*.log
```

**▼ 実行結果**

```plaintext
    358 /home/control/gitops12-joblog/ansible-check-dev.log
    992 /home/control/gitops12-joblog/ansible-check-prod.log
    358 /home/control/gitops12-joblog/ansible-check-stg.log
   2690 /home/control/gitops12-joblog/terraform-plan-dev.log
   4718 /home/control/gitops12-joblog/terraform-plan-prod.log
   2696 /home/control/gitops12-joblog/terraform-plan-stg.log
  11812 total
```

ジョブのログに出たものの中に、機密の値が何回出ているかを数えます。値そのものは表示せず、回数だけを数えます。数えるのは、tfstateの接続文字列（Secretsに登録しているもの）とそのパスワードの部分、Ansibleの接続に使う3環境の秘密鍵（Secretsに登録していない、tfstateから書き出したもの）です。秘密鍵は、鍵の本体の最初の行で数えます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
PG_PASS=$(printf '%s' "$PG_CONN_STR" | sed 's|^[^:]*://[^:]*:\([^@]*\)@.*$|\1|')
K_DEV=$(sed -n '2p' ansible/keys/dev/id_ed25519_generated)
K_STG=$(sed -n '2p' ansible/keys/stg/id_ed25519_generated)
K_PROD=$(sed -n '2p' ansible/keys/prod/id_ed25519_generated)
for f in ~/gitops12-joblog/*.log; do
  echo "== $(basename "$f")"
  echo "pg_conn_str=$(grep -cF "$PG_CONN_STR" "$f") pg_password=$(grep -cF "$PG_PASS" "$f")"
  echo "key_dev=$(grep -cF "$K_DEV" "$f") key_stg=$(grep -cF "$K_STG" "$f") key_prod=$(grep -cF "$K_PROD" "$f") begin_private_key=$(grep -c 'BEGIN OPENSSH PRIVATE KEY' "$f")"
  echo "private_key_openssh=$(grep -c 'private_key_openssh' "$f") identityfile=$(grep -c 'IdentityFile' "$f")"
done
unset PG_PASS K_DEV K_STG K_PROD
```

**▼ 実行結果**

```plaintext
== ansible-check-dev.log
pg_conn_str=0 pg_password=0
key_dev=0 key_stg=0 key_prod=0 begin_private_key=0
private_key_openssh=0 identityfile=38
== ansible-check-prod.log
pg_conn_str=0 pg_password=0
key_dev=0 key_stg=0 key_prod=0 begin_private_key=0
private_key_openssh=0 identityfile=114
== ansible-check-stg.log
pg_conn_str=0 pg_password=0
key_dev=0 key_stg=0 key_prod=0 begin_private_key=0
private_key_openssh=0 identityfile=38
== terraform-plan-dev.log
pg_conn_str=0 pg_password=0
key_dev=0 key_stg=0 key_prod=0 begin_private_key=0
private_key_openssh=1 identityfile=0
== terraform-plan-prod.log
pg_conn_str=0 pg_password=0
key_dev=0 key_stg=0 key_prod=0 begin_private_key=0
private_key_openssh=1 identityfile=0
== terraform-plan-stg.log
pg_conn_str=0 pg_password=0
key_dev=0 key_stg=0 key_prod=0 begin_private_key=0
private_key_openssh=1 identityfile=0
```

続けて、出たものが、どういう種類の情報かを確かめます。

**実行コマンド**

```plaintext
cd ~/gitops12-joblog
grep -n 'private_key_openssh' terraform-plan-dev.log | cut -c1-200
for f in terraform-plan-*.log; do echo "== $f"; echo "ANSIBLE_USER_PASSWORD=$(grep -c 'ANSIBLE_USER_PASSWORD' "$f") container_inspect=$(grep -c 'Docker container inspect' "$f") ip_172=$(grep -oE '172\.[0-9]+\.[0-9]+\.[0-9]+' "$f" | sort -u | tr '\n' ' ')"; done
for f in ansible-check-*.log; do echo "== $f"; echo "ip_172=$(grep -oE '172\.[0-9]+\.[0-9]+\.[0-9]+' "$f" | sort -u | tr '\n' ' ')"; done
```

**▼ 実行結果**

```plaintext
1481:2026-10-14T05:27:23.197Z [DEBUG] provider.terraform-provider-tls_v4.3.0_x5: Value switched to prior value due to semantic equality logic: @module=sdk.framework tf_provider_addr=registry.terraform
== terraform-plan-dev.log
ANSIBLE_USER_PASSWORD=0 container_inspect=2 ip_172=172.20.0.0 172.20.0.1 172.20.0.2
== terraform-plan-prod.log
ANSIBLE_USER_PASSWORD=0 container_inspect=6 ip_172=172.18.0.0 172.18.0.1 172.19.0.0 172.19.0.1 172.19.0.2 172.19.0.3 172.19.0.4
== terraform-plan-stg.log
ANSIBLE_USER_PASSWORD=0 container_inspect=2 ip_172=172.21.0.0 172.21.0.1 172.21.0.2
== ansible-check-dev.log
ip_172=172.20.0.2
== ansible-check-prod.log
ip_172=172.19.0.2 172.19.0.3 172.19.0.4
== ansible-check-stg.log
ip_172=172.21.0.2
```

同じ出力が、GitHubのジョブのログの画面でどう表示されているかを確かめます。

**▼ 実行結果**（「GitOps Pipeline」の実行#133、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）

```plaintext
2026-10-14T05:27:59.8008532Z <172.20.0.2> ESTABLISH SSH CONNECTION FOR USER: ***
2026-10-14T05:27:59.8015009Z <172.20.0.2> SSH: EXEC ssh -vvv -C -o ControlMaster=auto -o ControlPersist=60s -o StrictHostKeyChecking=no -o Port=22 -o 'IdentityFile="/home/control/actions-runner/_work/***-terraform-ci-lab/***-terraform-ci-lab/***/keys/dev/id_ed25519_generated"' -o KbdInteractiveAuthentication=no -o PreferredAuthentications=gssapi-with-mic,gssapi-keyex,hostbased,publickey -o PasswordAuthentication=no -o 'User="***"' -o ConnectTimeout=10 -o 'ControlPath="/home/control/.***/cp/9cf7129ec0"' 172.20.0.2 '/bin/sh -c '"'"'echo ~*** && sleep 0'"'"''
```

**▼ 実行結果**（「GitOps Pipeline」の実行#133、`terraform-plan`ジョブのステップ「Terraform plan」から抜粋）

```plaintext
2026-10-14T05:27:25.5375543Z 2026-10-14T05:27:25.536Z [INFO]  provider.terraform-provider-docker_v3.0.2: 2026/10/14 05:27:25 [DEBUG] Docker container inspect: {
2026-10-14T05:27:25.5377430Z 	"Id": "2d1667564d9f60a499423bb5a974ac8323b8f4364a642219813e72a42ee6e0a2",
2026-10-14T05:27:25.5378346Z 	"Created": "2026-10-13T07:30:21.99459295Z",
2026-10-14T05:27:25.5378954Z 	"Path": "/usr/sbin/sshd",
（途中省略："Args"と"State"の表示）
2026-10-14T05:27:25.5389993Z 	"Image": "sha256:339abaa620aa3e4201f09af17e7a4e6a7a1dda3a968069d907adedaf92ca59bc",
2026-10-14T05:27:25.5393280Z 	"ResolvConfPath": "/var/lib/docker/containers/2d1667564d9f60a499423bb5a974ac8323b8f4364a642219813e72a42ee6e0a2/resolv.conf",
（途中省略："HostnamePath"、"HostsPath"、"LogPath"の表示）
2026-10-14T05:27:25.5398812Z 	"Name": "/dev-node1",
```

確認が終わった後、プルリクエスト#71はマージせずに閉じ、作業用のブランチと、ランナーのホストに書き写したファイルを削除しました。mainのワークフローとdevの`main.tf`には、この確認の変更は入っていません。

**実行コマンド**

```plaintext
rm -r ~/gitops12-joblog
cd ~/iac/docker-lab-ci
git switch main
git branch -D gitops12-debug-log
git push origin --delete gitops12-debug-log
grep -c -E 'TF_LOG|-vvv|gitops12-joblog' .github/workflows/gitops-pipeline.yml
tail -1 terraform/envs/dev/main.tf
ls -la ~/gitops-pending
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Deleted branch gitops12-debug-log (was 85f7a7d).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops12-debug-log
0
}
total 8
drwx------  2 control control 4096 Oct 14 02:46 .
drwxr-x--- 14 control control 4096 Oct 14 06:03 ..
```

### ■ 結果

この検証環境の、この2つのコマンドのデバッグ出力では、数えた機密の値は、1回も出ませんでした。tfstateの接続文字列も、Ansibleの接続に使う秘密鍵の本体も、6つのファイルのどれにも含まれていません。`private_key_openssh`という属性の名前は出ていますが、tlsプロバイダーが値の扱いを記録したデバッグの行で、値は出ていません。イメージのビルドに渡すパスワードの変数名も出ていません。

代わりに出たのは、インフラの内部の情報でした。

|出力|ジョブのログに出たもの|
|---|---|
|`TF_LOG=TRACE`|コンテナの詳細のJSON（コンテナのID、イメージのハッシュ値、起動した時刻、ランナーのホストのDockerの保存場所）、各環境のネットワークのアドレスとゲートウェイ。prodには、どのコンテナも使っていない`ansible-app-net`のアドレス（`172.18.0.0`と`172.18.0.1`）も出ていた|
|`-vvv`|SSHの接続のコマンドそのもの（鍵のファイルのフルパス、`StrictHostKeyChecking=no`などの接続の指定、接続先のIPアドレス、接続を使い回すための`ControlPath`）|

GitHubのジョブのログの画面では、これらはそのまま表示されていました。伏せられていたのは、Secretsに登録した値と一致する`ansible`という語だけで、伏せ字はパスの途中にも入っています（`_work/***-terraform-ci-lab/...`）。ジョブのログの伏せ字は、Secretsに登録した値と一致する文字列を伏せる仕組みで、出力の中身が機密かどうかを判断するものではありません。Secretsに登録していない値は、たとえtfstateから書き出した秘密鍵であっても、伏せる対象になりません。

今回、秘密鍵の本体が出なかったのは、このパイプラインが、鍵をファイルとして書き出し、`ansible-playbook`にはそのパスだけを渡しているためです（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**）。`-vvv`に出るのは、鍵の中身ではなくパスです。この結果は、今回確かめた2つのコマンドと、この検証環境の値の渡し方に限ったものです。たとえば、Ansibleのタスクの引数にパスワードを直接書いている場合や、`--diff`で機密を含むファイルの差分を出す場合に、何がジョブのログに出るかは、この回では確かめていません。

デバッグ出力を有効にするときは、次の2点を前提にします。

* ジョブのログは、リポジトリを読める人に読まれる場所にある。デバッグ出力は、ディレクトリの構成、ネットワークの構成、接続の方法を、そのままそこに足す
* 伏せ字は、Secretsに登録した値にしか効かない。登録していない機密が出力に混ざれば、そのまま残る

そのため、デバッグ出力は、原因を調べるための一時的な変更として扱います。今回のように、作業用のブランチのプルリクエストの確認の実行で有効にし、mainには入れません。調べ終わったら、変更そのものを捨てます。

機密の値を、パイプラインの中でどこに置き、どう渡し、出力にどう出さないようにするかは、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

次のセクションでは、**[Ansible×Terraformシリーズ第3部](https://qiita.com/juehara-crypto/items/880dbb044c39d2d448cc)** のデバッグの知識を、ジョブを分けたこのパイプラインにどう持ち込めるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 前シリーズのデバッグの知識を持ち込む

**[Ansible×Terraformシリーズ第3部](https://qiita.com/juehara-crypto/items/880dbb044c39d2d448cc)** で扱ったデバッグの知識を、ジョブとステップを分けたこのパイプラインに持ち込むと、何がそのまま使え、何が変わるかを整理します。まず、Ansibleのタスクの失敗が、このパイプラインのジョブのログにどう出るかを実機で確かめます。

### ■ 検証内容：Ansibleのタスクの失敗を、確認の実行で起こす

**[Ansible×Terraformシリーズ第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** では、存在しないディレクトリにファイルを置くタスクを、Terraformの`local-exec`から実行して失敗させました。同じ種類のタスクを、ロールの最後に足します。**[セクション5](#5-ログはどこに残るか)** と同じく、マージしないプルリクエストの確認の実行だけを使います。

パイプラインで動かす前に、手元でdevだけに確認モードを実行します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops12-task-fail
cat >> ansible/roles/common_setup/tasks/main.yml <<'EOF'
- name: 存在しないディレクトリに設定ファイルを置く（第12回の確認用）
  become: true
  ansible.builtin.copy:
    dest: /etc/gitops12_nonexistent_dir/demo.conf
    content: "gitops12\n"
    mode: "0644"
EOF
cd ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
ansible-playbook -i inventories/dev site.yml --check --diff 2>/dev/null | tail -n 12; echo "exit_code=${PIPESTATUS[0]}"
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えの表示）
+++ after: /etc/gitops12_nonexistent_dir/demo.conf
@@ -0,0 +1 @@
+gitops12

changed: [dev-node1]

TASK [疎通確認] ****************************************************************
ok: [dev-node1]

PLAY RECAP *********************************************************************
dev-node1                  : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

exit_code=0
```

確認モードでは、このタスクは失敗にならず、`changed`として通りました。ディレクトリがあるかどうかを確かめないまま、「書き込めば変わる」と判断しています。

確認モードの中でタスクが失敗するところも見るため、「このファイルがあるはず」と確かめるタスクを、後ろにもう1つ足します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
cat >> ansible/roles/common_setup/tasks/main.yml <<'EOF'
- name: 設定ファイルがあることを確かめる（第12回の確認用）
  become: true
  ansible.builtin.file:
    path: /etc/gitops12_expected.conf
    state: file
EOF
cd ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
ansible-playbook -i inventories/dev site.yml --check --diff 2>/dev/null | tail -n 14; echo "exit_code=${PIPESTATUS[0]}"
```

**▼ 実行結果**

```plaintext
TASK [common_setup : 存在しないディレクトリに設定ファイルを置く（第12回の確認用）] ***
--- before
+++ after: /etc/gitops12_nonexistent_dir/demo.conf
@@ -0,0 +1 @@
+gitops12

changed: [dev-node1]

TASK [common_setup : 設定ファイルがあることを確かめる（第12回の確認用）] *******
fatal: [dev-node1]: FAILED! => {"changed": false, "msg": "file (/etc/gitops12_expected.conf) is absent, cannot continue", "path": "/etc/gitops12_expected.conf", "state": "absent"}

PLAY RECAP *********************************************************************
dev-node1                  : ok=5    changed=1    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0

exit_code=2
```

この2つのタスクを足した変更をコミットして、プルリクエスト#72を作りました。`ansible/`の変更なので、確認の実行（「GitOps Pipeline」の実行#134）では、`ansible-lint`と`molecule`も動きます。結果は、`changes`と`ansible-lint`が成功、`ansible-check`と`molecule`が失敗、`terraform-static`、`terraform-plan`、`record-pending`はスキップでした。

**▼ 実行結果**（「GitOps Pipeline」の実行#134、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
== dev

PLAY [接続確認用Playbook] ******************************************************
（途中省略：既存の4つのタスクの表示。いずれもok）
TASK [common_setup : 存在しないディレクトリに設定ファイルを置く（第12回の確認用）] ***
--- before
+++ after: /etc/gitops12_nonexistent_dir/demo.conf
@@ -0,0 +1 @@
+gitops12

changed: [dev-node1]

TASK [common_setup : 設定ファイルがあることを確かめる（第12回の確認用）] *******
fatal: [dev-node1]: FAILED! => {"changed": false, "msg": "file (/etc/gitops12_expected.conf) is absent, cannot continue", "path": "/etc/gitops12_expected.conf", "state": "absent"}

PLAY RECAP *********************************************************************
dev-node1                  : ok=5    changed=1    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0

Error: Process completed with exit code 2.
```

**▼ 実行結果**（「GitOps Pipeline」の実行#134、`molecule`ジョブのステップ「Molecule test」から抜粋）

```plaintext
（途中省略：dependency、cleanup、destroy、syntax、create、prepareの表示）
PLAY [Converge] ****************************************************************
（途中省略：既存の4つのタスクの表示）
TASK [common_setup : 存在しないディレクトリに設定ファイルを置く（第12回の確認用）] ***
fatal: [molecule-common-setup]: FAILED! => {"changed": false, "checksum": "671608de3068a5b97b4fb74ab5cec7075464fcbe", "msg": "Destination directory /etc/gitops12_nonexistent_dir does not exist"}

PLAY RECAP *********************************************************************
molecule-common-setup      : ok=4    changed=2    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0

CRITICAL Ansible return code was 2, command was: ***-playbook --inventory /home/control/.***/tmp/molecule.3cZV.default/inventory --skip-tags molecule-notest,notest /home/control/actions-runner/_work/***-terraform-ci-lab/***-terraform-ci-lab/***/roles/common_setup/molecule/default/converge.yml
ERROR    [default > converge] Executed: Failed
WARNING  [default > converge] An error occurred during the test sequence action: 'converge'. Cleaning up.
（途中省略：cleanupとdestroyの表示）
ERROR    Ansible return code was 2, command was: ***-playbook --inventory /home/control/.***/tmp/molecule.3cZV.default/inventory --skip-tags molecule-notest,notest /home/control/actions-runner/_work/***-terraform-ci-lab/***-terraform-ci-lab/***/roles/common_setup/molecule/default/converge.yml
ERROR    Molecule executed 1 scenario (1 failed)

DETAILS
（途中省略：各段階の結果）
default > converge: Executed: Failed (Ansible return code was 2, command was: ***-playbook --inventory /home/control/.***/tmp/molecule.3cZV.default/inventory --skip-tags molecule-notest,notest /home/control/actions-runner/_work/***-terraform-ci-lab/***-terraform-ci-lab/***/roles/common_setup/molecule/default/converge.yml)
（途中省略：各段階の結果）

SCENARIO RECAP
default                   : actions=9  successful=4  disabled=0  skipped=0  missing=5  failed=1

Error: Process completed with exit code 2.
```

**▼ 実行結果**（「GitOps Pipeline」の実行#134、`ansible-lint`ジョブのステップ「Ansible lint」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  env:
（途中省略：Secretsの環境変数の表示）
    ANSIBLE_INVENTORY_UNPARSED_FAILED: False
Passed: 0 failure(s), 0 warning(s) in 17 files processed of 18 encountered. Last profile that met the validation criteria was 'production'.
```

確認が終わった後、プルリクエスト#72はマージせずに閉じ、作業用のブランチを削除しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git branch -D gitops12-task-fail
git push origin --delete gitops12-task-fail
tail -2 ansible/roles/common_setup/tasks/main.yml
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Deleted branch gitops12-task-fail (was 07a95fb).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops12-task-fail
- name: ロールバック確認の後片付けのタスクを読み込み
  ansible.builtin.import_tasks: rollback_cleanup.yml
```

### ■ 結果

`ansible-check`の確認モードでは、2つ目のタスクの`fatal:`の行が、ステップ「Ansible check mode」のログに1回だけ出て、その後に`PLAY RECAP`と終了コードが続きました。**[Ansible×Terraformシリーズ第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** で、`local-exec`がAnsibleの出力を2か所に重複させ、罫線で囲んだ`exit status 2`のほうを目立たせていたのとは、出方が違います。このパイプラインは、TerraformとAnsibleを同じプロセスの中で入れ子にせず、ジョブとステップで分けて実行しているためです。ステップのログが、そのまま`ANSIBLE_LOG_PATH`で分離したログと同じ役割をしていて、行ごとにタイムスタンプも付いています。

一方、`molecule`のログでは、**[Ansible×Terraformシリーズ第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** と似た形が現れました。Moleculeは、テスト用のコンテナに対して`ansible-playbook`を本実行で動かし、その失敗を`CRITICAL`、`ERROR`、`DETAILS`と、3回まとめ直して出しています。`fatal:`の行は1回だけで、その後ろに、包んでいるツールのまとめが目立つ形で続きます。何かがAnsibleを包んで動かす限り、包んでいる側のまとめが目立ち、`fatal:`の行が埋もれるという **[Ansible×Terraformシリーズ第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** の構造は残ります。読むときは、包んでいる側のまとめではなく、最初の`fatal:`の行を探します。

そして、この検証で最も大きかったのは、確認モードと本実行の差です。1つ目のタスクは、手元の確認モードでも`ansible-check`でも`changed`で通りました。同じタスクが、Moleculeの本実行では`Destination directory /etc/gitops12_nonexistent_dir does not exist`で失敗しています。**[Ansible×Terraformシリーズ第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** の本実行と同じメッセージです。もし、Moleculeのテスト用のコンテナと、実際の操作対象の状態が違っていた場合（たとえば、テスト用のコンテナにはこのディレクトリがあり、操作対象にはない場合）、この失敗は、確認の実行を通り、マージと承認の後の「GitOps Apply」の`ansible-apply`で初めて現れることになります。確認モードが通ったことは、本実行が通ることを保証しません。

`ansible-lint`は、パイプラインでは成功しました。ステップの環境変数に`ANSIBLE_INVENTORY_UNPARSED_FAILED: False`があり、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** で組んだ、`unparsed_is_failed`との衝突の回避が効いています。手元で同じブランチに対してそのまま`ansible-lint`を実行したときは、この環境変数がないため、第8回で確認した`internal-error`になりました。パイプラインの失敗を手元で再現するときは、コマンドだけでなく、ステップの環境変数も合わせる必要があります。

### 持ち込めるもの、変わるもの

Ansible×Terraformシリーズ第3部の知識を、このパイプラインに当てはめると、次のとおりです。

|Ansible×Terraformシリーズの回|知識|このパイプラインでの扱い|
|---|---|---|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**|`local-exec`の出力の重複と、`ANSIBLE_LOG_PATH`による分離|ステップのログが分離したログの役割をする。ただし、Moleculeのように包むツールがあれば、まとめが目立ち`fatal:`が埋もれる構造は残る|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**|原因側の問題と可視性側の問題を分ける|**[セクション3](#3-設計どおりの停止か故障か)** の2つの判断（どの層か、設計どおりか）の前に、どこで止まったかを、ステップのログから読み取る|
|**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**|パスワードの入力待ちによる無応答|この検証環境は、パスワードなしで権限を上げる設定のため起きない。ジョブが待ち続ける症状は、**[セクション4](#4-self-hostedランナー特有の症状)** のランナーの停止として、別の層で起きる|
|**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)**|`TF_LOG`と`-vvv`の詳細度の違い|使い分けはそのまま使える。ジョブのログに出すと、**[セクション5](#5-ログはどこに残るか)** のとおり、インフラの内部の情報がGitHubに残る|
|**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)**|デバッグフラグは万能ではない|下の表のとおり、4つの層のうち、フラグが効くのはTerraform層とAnsible層だけ|

**[セクション2](#2-失敗を4つの層に分ける)** の4つの層ごとに、最初に見る場所と、デバッグフラグの効き方を並べると、次のとおりです。

|層|最初に見る場所|デバッグフラグ|
|---|---|---|
|GitHub Actions層|実行とジョブの状態（「Queued」「skipped」など）、ランナーの一覧、`changes`ジョブの判定の出力|効かない。ジョブが動いていないか、判定のとおりに動いているため|
|ガードレール層|止まったステップの`::error::`のメッセージ|効かない。メッセージが、止めた理由そのもの|
|Terraform層|止まったステップのエラーメッセージ|`TF_LOG=DEBUG`でTerraform本体の処理、`TF_LOG=TRACE`でプロバイダーと操作対象のやり取り|
|Ansible層|最初の`fatal:`の行と`PLAY RECAP`|`-vvv`でSSHの接続から権限の昇格まで、`-vvvv`でAnsible自体の起動と設定|

デバッグフラグが効くのは、TerraformやAnsibleが動き始めた後の失敗だけです。**[セクション3](#3-設計どおりの停止か故障か)** と **[セクション4](#4-self-hostedランナー特有の症状)** で確かめた、承認待ちとmainのずれ、ランナーの停止、変更なしの判定による成功は、どれもフラグを上げても情報が増えません。**[Ansible×Terraformシリーズ第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)** で、詳細化する処理まで到達していない失敗にはフラグが効かないと整理したのと、同じ構造です。

次のセクションでは、この4つの層の切り分けが、クラウドのプロバイダーでも変わらないことを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. クラウドでも4層の切り分けは変わらない

ここまでの切り分けが、TerraformのプロバイダーをAWSやGCPに切り替えたときに、どこが変わり、どこが変わらないかを整理します。

### 4つの層はそのまま残る

**[セクション2](#2-失敗を4つの層に分ける)** の4つの層は、パイプラインの役割で分けたものです。プロバイダーを切り替えても、ジョブを動かす仕組み、変更を止める仕組み、Terraform、Ansibleという並びは変わりません。

|層|この検証環境（Docker）|AWS・GCPに切り替えたとき|
|---|---|---|
|GitHub Actions層|self-hostedランナーの停止で、ジョブが「Queued」のまま待つ（**[セクション4](#4-self-hostedランナー特有の症状)**）|変わらない。ランナーをクラウドのネットワークの中に置けば、ランナーのインスタンスの停止で同じことが起きる|
|ガードレール層|入口の確認、静的なチェック、planの判定、昇格の順序|変わらない。planの判定は、`terraform show -json`の`actions`を読むので、プロバイダーを問わない（**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**）|
|Terraform層|pgバックエンドのstateロック、保存したplanの`Saved plan is stale`|メッセージの形は同じ。ロックの持ち方はバックエンドごとに違う（下で整理）|
|Ansible層|SSHの接続失敗、タスクの失敗|形は同じ。接続できない原因の候補が増える（下で整理）|

**[セクション3](#3-設計どおりの停止か故障か)** の2つの判断（どの層で止まったか、設計どおりの停止か）も、プロバイダーに関係しません。`Saved plan is stale`も、承認待ちとmainのずれも、パイプラインとTerraformの仕組みが出すもので、どのクラウドのリソースを扱っているかとは関係なく出ます。

### 変わるのは、各層の中の原因の候補

変わるのは、層の中で、何が原因になりうるかです。

**Terraform層：stateロックの持ち方**

この検証環境のpgバックエンドは、PostgreSQLのロックで、同時に動く実行を止めています（**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**）。クラウドでよく使われるバックエンドでは、S3はS3そのもののロックのファイル（`use_lockfile`）、GCSはバケットのオブジェクトでロックを持ちます。ロックが取れなかったときの`Error acquiring the state lock`という止まり方は同じですが、ロックがどこに残り、`terraform force-unlock`で外せるかどうかはバックエンドで違います。**[セクション3](#3-設計どおりの停止か故障か)** で整理したとおり、外せるバックエンドでは、ロックを外す操作が、ガードレールを壊す操作になりえます。

**Ansible層：接続できない原因**

この検証環境で、SSHの接続失敗の原因になりうるのは、鍵の不一致やコンテナの停止でした。クラウドでは、セキュリティグループやファイアウォールのルール、パブリックIPとプライベートIPの取り違え、インスタンスの起動直後でSSHがまだ受け付けていないこと、などが加わります。どれも、Ansible層の`UNREACHABLE!`として現れ、メッセージの最後の行（`Connection timed out`か`Permission denied`かなど）で、ネットワークの問題か認証の問題かを分けるところから始めます。

**[セクション3](#3-設計どおりの停止か故障か)** で見た、作り直した接続先のホスト鍵が`known_hosts`に残る問題も、クラウドで起きます。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** で整理したとおり、作り直しになる属性の変更はクラウドにもあり、IPアドレスを固定したまま作り直したり、同じIPアドレスが別のインスタンスに割り当てられたりすると、ランナーのユーザーの`known_hosts`の記録と、新しいインスタンスのホスト鍵が食い違います。

**Terraform層：デバッグ出力の中身**

`TF_LOG=TRACE`で出るのは、プロバイダーと操作対象のやり取りです。この検証環境では、Dockerのコンテナの詳細のJSONでした（**[セクション5](#5-ログはどこに残るか)**）。AWSやGCPでは、それがクラウドのAPIとのやり取りになります。何が出て、何が伏せられるかはプロバイダーによって違い、この回では確かめていません。ジョブのログの伏せ字が、Secretsに登録した値にしか効かないことは、プロバイダーに関係なく同じです。

### ランナーの置き場所

**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で整理したとおり、ランナーは、操作対象に届く場所に置く必要があります。クラウドでも、プライベートなネットワークの中のインスタンスにAnsibleで接続するなら、ランナーはそのネットワークに届く場所に置くことになり、self-hostedランナーの運用（**[セクション4](#4-self-hostedランナー特有の症状)** のランナーの停止、ホストに残るもの、ホストのツールのバージョン）は、そのまま残ります。

ホステッドランナーを使う構成でも、ジョブが待ち続ける症状は、ランナーの停止ではなく、同時に動かせる数の上限などで起きえます。待っている理由は違っても、ジョブがどのランナーにも渡っていない間は、GitHub Actions層で起きていることで、ガードレールもTerraformもAnsibleも動いていないことは同じです。

クラウドの認証情報を、パイプラインの中でどう渡すか（長く使える鍵を置くか、実行ごとに短い期間だけ使える認証にするか）は、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

プロバイダーを切り替えて変わるのは、各層の中の原因の候補と、デバッグ出力の中身です。4つの層に分けること、止まったステップで層を決めること、設計どおりの停止かどうかを、そのメッセージを出した仕組みで判断することは、プロバイダーを問わず同じ形で使えます。

次のセクションでは、この回で整理した内容と、第2部全体をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

* パイプラインの失敗は、GitHub Actions層、ガードレール層、Terraform層、Ansible層の4つに分けられる。層は使っているツールではなく処理の役割で分け、1つのジョブに複数の層のステップが入るため、どの層で止まったかは、止まったジョブではなく止まったステップで決まる
* 第5〜11回で実際に出たメッセージを層ごとに並べると、多くはガードレール層の入口の確認やチェックが出したもので、GitHub Actions層とTerraform層にも、意図して止めるために組んだ仕組みのメッセージがある
* 承認の前に手元から適用すると`Saved plan is stale`で止まり、パイプラインの鍵を外すとSSHの接続が`UNREACHABLE!`で止まることを実機で確認した。どちらもジョブの状態は「失敗」で、区別できたのは、止まったステップとメッセージだった。前者は設計どおりの停止で、直すのは手順。後者は故障で、直すのは環境である
* 手元から適用した変更は、判定の基準である「最後に適用したコミット」に入らないため、取り消すマージの実行は「変更なし」と判定されて成功し、その裏でdevのtfstateとコードが食い違っていた。この食い違いに最初に引っかかったのは、次の適用の入口の、承認待ちとmainのずれの確認だった
* 設計どおりの停止を故障と取り違えると、ロックの解除、`allow_destroy`の付け直し、チェックのステップの削除といった、ガードレールを壊す操作につながる
* self-hostedランナーが止まっていると、ジョブは失敗にならず「Queued」のまま待ち続け、ランナーを起動すると同じジョブが拾われて成功することを実機で確認した。この間、ガードレールもTerraformもAnsibleも動いておらず、ジョブのログもない
* 作業ディレクトリの残りものは、次にチェックアウトをするジョブの最初に削除される。作業ディレクトリの外にあるもの（Moleculeの作業用のディレクトリ、ランナーのユーザーの`known_hosts`）は残り続け、`known_hosts`に残った古いホスト鍵は、SSHの接続失敗のログの先頭に、原因ではない警告として現れた
* ジョブが使うツールのバージョンは、ワークフローにもリポジトリにも書かれず、ランナーのホストに何が入っているかで決まる
* `TF_LOG=TRACE`と`-vvv`を有効にした確認の実行では、tfstateの接続文字列と秘密鍵の値はジョブのログに出なかった。代わりに、ランナーのホストのディレクトリの構成、ネットワークの構成、接続の方法がそのまま出た。ジョブのログの伏せ字は、Secretsに登録した値に一致する文字列にしか効かない
* このパイプラインでは、Ansibleの`fatal:`の行はステップのログに1回だけ出て、`local-exec`のような重複は起きない。ただし、Moleculeのように包むツールがあれば、そのまとめが目立つ構造は残る
* 確認モードで`changed`として通ったタスクが、Moleculeの本実行では失敗することを実機で確認した。確認モードが通ったことは、本実行が通ることを保証しない
* デバッグフラグが効くのは、TerraformとAnsibleが動き始めた後の失敗だけで、GitHub Actions層とガードレール層の停止には効かない
* プロバイダーを切り替えて変わるのは、各層の中の原因の候補とデバッグ出力の中身で、4つの層に分けること、止まったステップで層を決めること、設計どおりかをメッセージを出した仕組みで判断することは変わらない

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

本シリーズの **[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** では、`git revert`で取り消した変更が、パイプラインのどの段階でも止まらずに成功する一方で、OSの中には取り消したはずの設定が残ることを確認し、ロールバックの非対称性を整理しました。第12回となる今回は、反対に、パイプラインが止まったときにどこを見ればよいかを扱いました。パイプラインの失敗を4つの層に分け、第5〜11回で出たメッセージを層ごとに並べたうえで、設計どおりの停止と故障を、止まったステップとメッセージで見分けられることを実機で確認しました。そのうえで、self-hostedランナーの停止でジョブが失敗せずに待ち続けること、デバッグ出力がジョブのログに残すもの、確認モードを通ったタスクが本実行で失敗することを確かめ、Ansible×Terraformシリーズ第3部の知識を、このパイプラインにどう持ち込めるかを整理しました。

今回で、第2部は終わりです。第2部では、**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** で示した「唯一の真実」が崩れる経路のうち、Gitを経由しない手動変更に対して、変更がGitを通って初めてインフラに届くパイプラインを積み上げてきました。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** でプルリクエストで確認し、マージで適用する基本の流れを組み、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** でtfstateの置き場所と同時実行への備えを加えました。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、レビューしたplanだけを、承認したときだけ適用する承認ゲートを組み、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** と **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** で、AnsibleとTerraformの両側のチェックとplanの判定を、その入口の条件にしました。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** では環境を分けて昇格の順序を守らせ、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** では、Gitを戻してもインフラは戻らないことを確かめました。今回は、それらの仕組みが止まったときの読み方を整理しました。一方で、今回の検証では、手元から適用した1つの変更が、パイプラインの判定に入らないまま残ることも確認しました。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** で整理したとおり、パイプラインで経路を絞っても、パイプラインの外からの変更はなくせません。その変化を見つけて戻す仕組みは、第4部（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** 〜 **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**）で扱います。

次回からは、第3部「GitOpsパイプラインでの機密情報管理」に入ります。第2部では、機密情報の扱いを暫定のまま残してきました。Ansibleの接続に使う秘密鍵は、tfstateからジョブの中で書き出して使い、コンテナのユーザーのパスワードとtfstateのデータベースへの接続文字列は、GitHubのSecretsから渡しています。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、保存したplanに含まれる機密情報の扱いを第3部に送りました。今回は、デバッグ出力を有効にしても、数えた機密の値はジョブのログに出なかった一方で、ジョブのログの伏せ字が、Secretsに登録した値にしか効かないことを確認しました。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** では、「すべてをGitに置く」というGitOpsの原則と、Gitに平文で置けない機密情報との衝突を出発点に、非公開のリポジトリでも十分ではない理由を整理します。そのうえで、第2部で残した機密情報を、パイプラインがツールを動かすための鍵と、操作対象に入れる秘密の値に分けて棚卸しし、tfstate、保存したplan、ジョブのログという、Git以外に機密情報が漏れる経路を洗い出します。

**[次回：第13回：なぜGitリポジトリに機密情報を置いてはいけないのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)　｜　[次の記事：【GitOps編】第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)**

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
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**|失敗したパイプラインをどう診断するか|パイプラインの失敗をGitHub Actions・ガードレール・Terraform・Ansibleの4層に分け、「設計どおりの停止か、故障か」を、止まったステップとメッセージで切り分ける。self-hostedランナーの停止で待ち続けるジョブ、デバッグ出力がジョブのログに残すもの、確認モードを通って本実行で失敗するタスクを実機で示し、Ansible×Terraformシリーズ第3部の知識の持ち込み方を整理する。第2部の最終回。|
---

[↑ 目次に戻る](#-目次)

---