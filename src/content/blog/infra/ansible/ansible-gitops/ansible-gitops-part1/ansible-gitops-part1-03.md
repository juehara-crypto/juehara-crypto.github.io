---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第3回：GitリポジトリとAnsibleの構造設計'
description: 'Gitリポジトリの構造を、コミットされた変更に対してどのツールの判定から始めるかを決めるための設計として扱う。変更の分類をパスで表現するディレクトリ構成、Gitに置くものと置かないもの、モノレポとマルチリポの選択基準、mainを唯一の真実とするブランチ運用を整理し、mainへの直接プッシュを防げない環境では、強制する場所を適用前に移す方針を示す。'
pubDate: 2026-09-30
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'Git', 'リポジトリ設計']
seriesId: 'ansible-gitops-part1'
seriesNo: 3
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>


> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第1部まとめブログ：「Gitが唯一の真実」を成り立たせる前提の設計** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [変更の分類をパスで表現する](#2-変更の分類をパスで表現する)
3. [Gitに置くものと置かないもの](#3-gitに置くものと置かないもの)
4. [モノレポとマルチリポの選択基準](#4-モノレポとマルチリポの選択基準)
5. [mainを唯一の真実にするブランチ運用](#5-mainを唯一の真実にするブランチ運用)
6. [既存リポジトリの構成を確認する](#6-既存リポジトリの構成を確認する)
7. [プロバイダーを切り替えても変わる範囲](#7-プロバイダーを切り替えても変わる範囲)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#10-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

AnsibleのPlaybookとTerraformのコードをGitで管理していて、

* PlaybookもTerraformのコードも、1つのリポジトリにまとめて置いている
* 変更はコミットし、mainブランチにプッシュしている
* コードがすべてGitにあるので、GitOpsの準備はできている

と考えていないでしょうか。

リポジトリのディレクトリ構成は、ファイルを探しやすくするための整理として扱われることがあります。しかし、GitOpsで運用すると、変更はすべてコミットとして届き、そのコミットを受けてパイプラインが何を実行するかを決めることになります。このとき、次のような場面にぶつかります。

* Playbookを1行直しただけなのに、毎回`terraform plan`まで実行される
* tfstateを誤ってコミットしてしまった
* 生成したインベントリがコミットされていて、古いIPアドレスに接続しようとする
* リポジトリを分けた結果、AnsibleとTerraformの実行順序を保証できなくなった
* mainへの直接プッシュを禁止しようとしたが、リポジトリの条件によってはブランチ保護のルールを作っても効かなかった

これらは、ファイルの置き場所やブランチの使い方の問題に見えます。共通しているのは、コミットされた変更に対して、どのツールを動かし、何をGitに残すかが、リポジトリの構造として決まっていない点です。

本シリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** では、コミットされる変更を、Terraformだけで完結する変更、Ansibleだけで完結する変更、両方にまたがる変更の3つに分類し、変更の種類ごとに必要な実行の順序を整理しました。同じ回で、どのツールの実行が必要になるかは変更したファイルからは決まらず、`terraform plan`の結果から見分けられることも確認しました。また、AnsibleとTerraformの接続面であるIPアドレスはtfstateと、そこから生成したインベントリにあり、Gitで管理するのは値ではなく値の生成手順であることを確認しました。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** では、Gitを経由しない手動変更に対し、変更の経路をGitに限定し、Gitを通った変更だけが適用される仕組みを第2部（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** 〜 **[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**）で作ると整理しました。

リポジトリの構造そのものは、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも部分的に扱ってきました。Ansible×Terraformシリーズの **[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** と **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** では、`.github/workflows/`にワークフローを置き、Terraformによるコンテナの起動からAnsibleの適用、定期的なドリフトの検知までを、GitHub Actionsで実行しました。**[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)** では、TerraformのモジュールとAnsibleのロールで共通部分を1か所にまとめ、共通化によって「誰が共通部分を変更してよいか」という運用ルールが必要になることを、課題の所在として示すにとどめました。モジュールやロールの内部の構成は、この回では再解説しません。

この回では、**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** の変更の分類を、リポジトリのディレクトリ構成、Gitに置くものと置かないもの、リポジトリの分け方、ブランチの運用に落とし込みます。変更されたファイルだけでは実行するツールが決まらない以上、ディレクトリ構成で決められるのは、どのツールの判定から始めるかです。Ansibleだけに関わるパスの変更であれば、Terraformの判定は要りません。Terraformのパスを含む変更であれば、まず`terraform plan`を実行し、その結果からAnsibleの実行が必要かを決めます。

正確に言うと、**ディレクトリ構成は見た目の整理ではなく、コミットされた変更に対して、パイプラインがどのツールの判定から始めるかを決めるための入力です**。この回で扱う問いは、「コミットされた変更のパスから、どのツールの判定を始めればよいかが決まるリポジトリの構造は、どう作るのか」です。

次のセクションでは、**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** の3分類を、ディレクトリ単位で表現します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 変更の分類をパスで表現する

**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** の3分類をディレクトリ単位で表現し、変更されたパスと、パイプラインが最初に行う判定との対応を示します。

### ディレクトリを分ける基準

リポジトリの中のファイルは、どのツールがそのファイルを読むかで置き場所を決めます。

```
（リポジトリのルート）
├─ .github/
│　　└─ workflows/　　パイプラインの定義
├─ terraform/　　　　　Terraformが読むファイル（HCL、インベントリの生成に使うテンプレート、イメージの定義など）
└─ ansible/　　　　　　Ansibleが読むファイル（Playbook、ロール、Ansibleの設定など）
```

インベントリの生成に使うテンプレートは、Ansibleのための書式を定めたファイルですが、読むのはTerraformの`templatefile`です。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション2で確認したとおり、テンプレートから生成したインベントリは`local_file`リソースとして`terraform plan`に現れます。テンプレートを変更したときに差分が現れるのはTerraformの側なので、`terraform/`に置きます。コンテナのイメージを定義する`Dockerfile`も、Terraformの`docker_image`が読むため、同じく`terraform/`に置きます。

生成したインベントリやtfstateのように、ツールの実行によって作られるファイルは、このツリーに含めていません。これらの扱いは、**[セクション3](#3-gitに置くものと置かないもの)** で整理します。

### 変更されたパスと最初に行う判定

**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** では、どのツールの実行が必要になるかは変更したファイルからは決まらず、`terraform plan`の結果から見分けられることを確認しました。そのため、変更されたパスから決められるのは、必要な実行そのものではなく、最初にどの判定を行うかです。

|変更されたパス|最初に行う判定|判定の結果と必要な実行|
|---|---|---|
|`ansible/`配下だけ|なし|Terraformの判定は要らない。`ansible-playbook`を実行する|
|`terraform/`配下を含む|`terraform plan`|追加するリソースだけが現れた場合は、`terraform apply`だけで反映できる。コンテナの`will be created`やインベントリの再作成が現れた場合は、`terraform apply`→`ansible-playbook`の順に実行する。コンテナの`must be replaced`が現れた場合は、同じ順序で、作り直したコンテナにPlaybookの全タスクを適用し直す|
|`terraform/`配下と`ansible/`配下の両方|`terraform plan`|`terraform/`配下を含む場合の判定に加えて、`ansible/`配下の変更を反映するため、`terraform plan`の結果にかかわらず`ansible-playbook`も実行する。順序は`terraform apply`→`ansible-playbook`とする|

`ansible/`配下だけの変更でTerraformの判定を省けるのは、**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション5で整理したとおり、Playbookやロールだけの変更はHCLに触れず、`terraform plan`に差分が現れないためです。冒頭の「Playbookを1行直しただけなのに、毎回`terraform plan`まで実行される」という場面は、この判定を省けていない状態です。

一方、`terraform/`配下を含む変更は、変更したファイルが`terraform/`配下だけであっても、Ansibleの実行が必要になる場合があります。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** で確認したノードの追加と環境変数の追加は、どちらも変更したファイルは`main.tf`だけでしたが、Ansibleの実行が必要な変更でした。そのため、`terraform/`配下の変更は、`terraform plan`の結果を見るまで、Ansibleの要否を決めません。

待ち受けポートと外部公開ポートのように、1つの値が両方のツールにまたがる設定は、**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション3で、同じコミットで`main.tf`とPlaybookの両方を変えると整理しました。このコミットは、表の3行目の「`terraform/`配下と`ansible/`配下の両方」に当たります。

### この対応が成り立つ条件

この対応は、`terraform/`配下のファイルをAnsibleが読まず、`ansible/`配下のファイルをTerraformが読まない場合に限って成り立ちます。

たとえば、Terraformのリソース定義からPlaybookのファイルを参照すると、Playbookの変更が`terraform plan`に現れるようになります。Ansible×Terraformシリーズの **[第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)** で扱った、`null_resource`の`triggers`にPlaybookのハッシュ値を指定する構成がこれに当たります。この構成では、`ansible/`配下だけの変更でも、Terraformの判定が必要になります。ディレクトリを分けるだけでなく、ツールをまたいでファイルを参照しないことも、パスから判定の入口を決めるための条件になります。

`.github/workflows/`配下は、パイプラインそのものの定義です。変更されたパスに応じてジョブを切り替える仕組みは、この表を入力として **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で実装します。`terraform plan`の結果から作り直しや削除を読み取り、Ansibleの設定の消失を適用前に扱う仕組みは、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** で扱います。

次のセクションでは、ツールの実行によって作られるファイルを含め、Gitに置くものと置かないものを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. Gitに置くものと置かないもの

リポジトリの中のファイルを、Gitに置くものと置かないものに分け、その境界を`.gitignore`で引きます。

### 置くものと置かないものの基準

**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション4では、AnsibleとTerraformの接続面であるIPアドレスは`terraform apply`の後にしか決まらず、Gitで管理するのは値ではなく値の生成手順であることを確認しました。この考え方を、作業ディレクトリにあるファイル全体に広げると、次のようになります。

|ファイル|作られるタイミング|Gitに置くか|理由|
|---|---|---|---|
|HCL、テンプレート、Playbook、ロール|人が書く|置く|あるべき状態と、値の生成手順そのもの|
|`.terraform.lock.hcl`|`terraform init`|置く|選んだプロバイダーのバージョンを、コードの変更と同じようにレビューするため|
|`.terraform/`|`terraform init`|置かない|プロバイダーとモジュールのキャッシュ|
|tfstate（`terraform.tfstate`、`terraform.tfstate.backup`）|`terraform apply`|置かない|実行の結果。値は`terraform apply`の後に決まる|
|`inventory.ini`、`group_vars/target_nodes.yml`|`terraform apply`|置かない|tfstateの値から生成した接続先|
|`id_ed25519_generated`|`terraform apply`|置かない|Terraformが生成した秘密鍵|
|`terraform.tfvars`|人が書く|置かない|環境ごとの変数の値で、パスワードを含む|
|`__pycache__/`、`.pytest_cache/`|テストの実行|置かない|テストツールのキャッシュ|

`.terraform.lock.hcl`と`.terraform/`は、どちらも`terraform init`が作るファイルですが、扱いが分かれます。Terraformの公式ドキュメント（**[Dependency Lock File](https://developer.hashicorp.com/terraform/language/files/dependency-lock)**）では、ロックファイルは`terraform init`が作成・更新するファイルであり、依存するプロバイダーの変更をコードレビューで扱えるよう、バージョン管理に含めるべきとされています。ロックファイルの中身は、どのバージョンを使うかという決定です。一方、`.terraform/`の中身は、その決定に従ってダウンロードしたプロバイダーのキャッシュです。

つまり、Gitに置くかどうかは、ツールが生成したファイルかどうかでは決まりません。中身が「決めたこと」であれば置き、「実行の結果」であれば置きません。tfstate、生成したインベントリ、生成した秘密鍵は、いずれも実行の結果です。

例外は`terraform.tfvars`です。変数の値は人が決めて書くものですが、この検証環境では、ファイルにパスワードの変数が入っています。

**実行コマンド**

```plaintext
grep -oE '^[A-Za-z_]+' terraform.tfvars
```

**▼ 実行結果**

```plaintext
ansible_user_password
deploy_user_password
```

決めたことであっても、秘密の値はGitに置けません。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション7で、Gitに置けない機密情報を第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱うと整理したとおり、パスワードや生成した秘密鍵をパイプラインの中でどう扱うかは、第3部で設計します。tfstate自体の置き場所は、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** で扱います。この回では、これらをGitに置かないという境界を引くところまでを扱います。

### `.gitignore`で境界を引く

表の「置かない」ファイルを、`.gitignore`に書きます。

* **ファイル名：`.gitignore`**

```plaintext
# Terraformの状態（実行の結果。値はtfstateにだけある）
*.tfstate
*.tfstate.*

# 環境ごとの変数の値（パスワード等を含む）
*.tfvars

# terraform initが作るプロバイダーとモジュールのキャッシュ
.terraform/

# Terraformが実行のたびに生成するファイル
inventory.ini
**/group_vars/target_nodes.yml
id_ed25519_generated

# テストツールのキャッシュ
__pycache__/
.pytest_cache/
```

`group_vars`は、ディレクトリごとではなく、Terraformが生成する`target_nodes.yml`だけを除外しています。`group_vars/`には、人が書いた変数ファイルを置くこともできるためです。tfstateと`*.tfvars`の除外は、GitHubが公開しているTerraform用の`.gitignore`のテンプレート（**[github/gitignore](https://github.com/github/gitignore/blob/main/Terraform.gitignore)**）にも含まれています。

除外の設定は、リポジトリに含まれる`.gitignore`に書くことで、リポジトリをクローンしたすべての作業ディレクトリに届きます。Gitの公式ドキュメント（**[gitignore](https://git-scm.com/docs/gitignore)**）でも、クローンを通じて他の作業ディレクトリと共有すべき除外のパターンは`.gitignore`に書く、とされています。GitOpsでは、開発者の手元だけでなく、パイプラインを実行する環境でもリポジトリをクローンします。本シリーズでは、**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で導入するself-hostedランナーがこれに当たります。除外の設定がリポジトリに含まれていなければ、そうした作業ディレクトリでは除外が効きません。

### ■ 検証内容：別の作業ディレクトリでの除外の確認

`.gitignore`をコミットしたリポジトリを別のディレクトリにクローンし、実行で作られるファイルと同じ名前の空ファイルを置いて、除外されるかを確認します。あわせて、人が書く変数ファイルを想定した`group_vars/all.yml`も置きます。

**実行コマンド**

```plaintext
git clone -q ~/iac/docker-lab-ci /tmp/gitops03-clone
cd /tmp/gitops03-clone
mkdir -p group_vars .terraform
touch terraform.tfstate terraform.tfstate.backup terraform.tfvars inventory.ini group_vars/target_nodes.yml group_vars/all.yml id_ed25519_generated
```

**▼ 実行結果**

```plaintext
（出力なし）
```

**実行コマンド**

```plaintext
git status --ignored --short --untracked-files=all
```

**▼ 実行結果**

```plaintext
?? group_vars/all.yml
!! group_vars/target_nodes.yml
!! id_ed25519_generated
!! inventory.ini
!! terraform.tfstate
!! terraform.tfstate.backup
!! terraform.tfvars
```

どの行で除外されたかを確認します。`-n`を付けて、除外されないファイルも表示します。

**実行コマンド**

```plaintext
git check-ignore -v -n terraform.tfstate terraform.tfstate.backup .terraform inventory.ini group_vars/target_nodes.yml group_vars/all.yml id_ed25519_generated terraform.tfvars .terraform.lock.hcl main.tf; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
.gitignore:2:*.tfstate  terraform.tfstate
.gitignore:3:*.tfstate.*        terraform.tfstate.backup
.gitignore:9:.terraform/        .terraform
.gitignore:12:inventory.ini     inventory.ini
.gitignore:13:**/group_vars/target_nodes.yml    group_vars/target_nodes.yml
::      group_vars/all.yml
.gitignore:14:id_ed25519_generated      id_ed25519_generated
.gitignore:6:*.tfvars   terraform.tfvars
::      .terraform.lock.hcl
::      main.tf
exit_code=0
```

### ■ 結果

クローンした作業ディレクトリでも、表の「置かない」ファイルはすべて`.gitignore`の行で除外されました（`!!`）。`.terraform`は空のディレクトリのため`git status`には表示されていませんが、`git check-ignore`では`.gitignore`の9行目で除外対象になっています。

一方、人が書く変数ファイルを想定した`group_vars/all.yml`は除外されず、`??`（まだGitに追加していないファイル）として表示されました。Gitに置く`.terraform.lock.hcl`と`main.tf`も、除外の対象になっていません（`::`）。

### すでにコミットしたファイルには効かない

`.gitignore`で除外できるのは、まだGitに追加していないファイルだけです。Gitの公式ドキュメント（**[gitignore](https://git-scm.com/docs/gitignore)**）にも、すでにGitで管理されているファイルには影響しないと書かれています。冒頭の「tfstateを誤ってコミットしてしまった」場面では、後から`.gitignore`に書いても、そのファイルは管理対象のまま残り、コミットの履歴にも残ります。

そのため、`.gitignore`を置いたら、置かないはずのファイルが過去にコミットされていないかも確認します。

**実行コマンド**

```plaintext
git log --all --oneline -- '*.tfstate' '*.tfstate.*' '*.tfvars' 'inventory.ini' 'group_vars/*' 'id_ed25519_generated' '.terraform/*'; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
exit_code=0
```

コミットの一覧は1行も表示されず、表の「置かない」ファイルが過去にコミットされた履歴はありませんでした。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション4では、tfstateと生成したインベントリが現在の管理対象に含まれていないことを確認しましたが、これで過去の履歴にも含まれていないことが分かります。

`.gitignore`は、Gitに置くもの、つまりあるべき状態として記録するものと、Gitの外に置くものとの境界線です。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** で整理したとおり、「Gitが唯一の真実」と言えるのは、Gitに記述されている範囲の中だけです。`.gitignore`は、その範囲の外に何を置いたかを、リポジトリの中に記録するファイルでもあります。

次のセクションでは、AnsibleとTerraformのコードを1つのリポジトリに置くか、分けるかの選択基準を扱います。

---

[↑ 目次に戻る](#-目次)

---

## 4. モノレポとマルチリポの選択基準

AnsibleとTerraformのコードを1つのリポジトリに置く構成（モノレポ）と、ツールごとにリポジトリを分ける構成（マルチリポ）を、2つの基準で比較し、本シリーズの選択を示します。

### 2つの判定基準

どちらを選ぶかは、次の2つの基準で判定します。

* 両方にまたがる変更を、1つのコミットで扱う必要があるか
* ツールごとに、変更できる人を分ける必要があるか

### 両方にまたがる変更を1つのコミットで扱えるか

**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション3では、待ち受けポートと外部公開ポートのように1つの値が両方のツールにまたがる設定は、同じコミットで`main.tf`とPlaybookの両方を変えると整理しました。片方だけを変えると、外部公開ポートの転送先で待ち受けるサーバーがなくなり、外部から接続できなくなるためです。

モノレポであれば、この変更は`terraform/`と`ansible/`の両方を変える1つのコミットになります。**[セクション2](#2-変更の分類をパスで表現する)** の表の3行目に当たり、パイプラインは`terraform apply`→`ansible-playbook`の順に実行できます。

マルチリポでは、同じ変更がリポジトリごとの2つのコミットに分かれます。2つのコミットがそれぞれのmainに入るまでの間は、片方だけが変わった状態がmainに存在します。さらに、Terraformを先に実行する必要があるため、Ansibleのリポジトリのパイプラインは、Terraformのリポジトリの適用が終わるのを待たなければなりません。リポジトリをまたいで実行順序を保証する仕組みが、別に必要になります。

この問題は、両方のファイルを変える変更に限りません。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション2で確認したノードの追加は、変更したファイルは`main.tf`だけでしたが、Ansibleの実行も必要な変更でした。マルチリポでは、Terraformのリポジトリへのコミットをきっかけに、Ansibleのリポジトリのパイプラインを起動する必要があります。そのとき、tfstateから生成したインベントリも、リポジトリをまたいで受け渡すことになります。AnsibleとTerraformの接続面が、リポジトリの境界もまたぐということです。

あるべき状態の記録も分かれます。モノレポでは、ある時点のあるべき状態は1つのコミットで表せます。マルチリポでは、2つのリポジトリのどのコミットの組み合わせを適用したかを記録しなければ、あるべき状態を特定できません。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** で導入する「環境ごとに最後に適用したコミット」の記録も、マルチリポではリポジトリの数だけ必要になります。

### 変更できる人を分ける必要があるか

Ansible×Terraformシリーズの **[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)** のセクション7では、共通化によって、誰が共通部分を変更してよいかという運用ルールが必要になることを、課題の所在として示しました。インフラのリソースを変更できる人と、OSの中の設定を変更できる人を分けたい場合、リポジトリの構成が関わってきます。

マルチリポであれば、リポジトリごとに、誰をコラボレーターとして招待するかで、変更できる人を分けられます（**[Inviting collaborators to a personal repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/inviting-collaborators-to-a-personal-repository)**）。

モノレポで同じことをするには、パス単位で分ける必要があります。GitHubでは、`CODEOWNERS`ファイルにパスごとの担当者を書くと、そのパスを変更するプルリクエストで担当者にレビューが依頼されます。担当者の承認をマージの条件にするには、ブランチ保護かルールセットで「Require review from Code Owners」を有効にする必要があります（**[About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)**）。ただし、`CODEOWNERS`はリポジトリのプランや公開設定によっては使えず、ブランチ保護も、ルールを作成できても強制されない場合があります。ブランチ保護が強制されない場合については、**[セクション5](#5-mainを唯一の真実にするブランチ運用)** で扱います。

### 本シリーズの選択

2つの基準で並べると、次のとおりです。

|観点|モノレポ|マルチリポ|
|---|---|---|
|両方にまたがる変更|1つのコミットで扱える|リポジトリごとのコミットに分かれ、リポジトリをまたいで実行順序を保証する仕組みが必要になる|
|接続面（インベントリ）の受け渡し|同じリポジトリのパイプラインの中で、生成して渡せる|リポジトリをまたいで受け渡す必要がある|
|あるべき状態の記録|1つのコミットで表せる|リポジトリごとのコミットの組み合わせで表す|
|変更できる人の分離|パス単位。`CODEOWNERS`とブランチ保護が必要で、それが効くかはリポジトリの条件による|リポジトリ単位で分けられる|

本シリーズは、モノレポを採用します。両方にまたがる変更を1つのコミットで扱えることと、接続面の受け渡しを1つのパイプラインの中で完結できることを優先します。変更できる人については、検証環境で再現できる範囲として、AnsibleとTerraformのどちらのコードも同じ人が変更できる運用を前提にします。

一方、インフラのリソースを扱うチームとサーバーの運用チームが分かれている現場のように、変更できる人をツールごとに分ける必要がある場合は、マルチリポを選ぶ理由があります。その場合は、上の表の右列にある、リポジトリをまたいだ実行順序の保証、接続面の受け渡し、コミットの組み合わせの記録を、代償として設計する必要があります。モノレポのまま分ける場合は、`CODEOWNERS`が使え、ブランチ保護が強制されるリポジトリであることが前提になります。

次のセクションでは、1つにまとめたリポジトリのmainブランチを「唯一の真実」とするための、ブランチの運用を扱います。

---

[↑ 目次に戻る](#-目次)

---

## 5. mainを唯一の真実にするブランチ運用

mainブランチを「唯一の真実」とするブランチ運用の原則を示し、その原則を強制する手段が、リポジトリの条件によっては効かないことを実機で確認します。

### 変更はプルリクエストを通してmainに入れる

GitOpsでは、パイプラインがインフラに適用するのは、mainブランチに入ったコミットです。mainの内容が、あるべき状態としてインフラに反映されます。そのため、本シリーズでは次の原則をとります。

* mainを「唯一の真実」とし、インフラに適用するのはmainに入ったコミットに限る
* 変更は作業用のブランチでコミットし、プルリクエストを通してmainに入れる。mainへは直接プッシュしない

プルリクエストを通すことで、mainに入る前に、変更の内容と、**[セクション2](#2-変更の分類をパスで表現する)** で示した判定の結果を確認する場所ができます。プルリクエストで確認し、マージで適用する基本の流れは **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で作ります。環境ごとにブランチを分ける運用はとらず、環境の分け方は **[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** で扱います。

### 原則をGitHubの側で強制する手段

GitHubでは、ブランチ保護（またはルールセット）でmainにルールを設定すると、プルリクエストを通さない直接プッシュを拒否できます。ただし、GitHubの公式ドキュメント（**[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)**）では、非公開リポジトリでブランチ保護を使うには、上位のプランが必要とされています。本シリーズでは、リポジトリを非公開で運用します。非公開にする理由は、**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で扱います。

同じドキュメントには、ブランチ保護のルールは既定では管理者権限を持つ人には適用されず、「Do not allow bypassing the above settings」を有効にした場合に限り、管理者にも適用されるとも書かれています。

この検証環境の非公開リポジトリで、mainにルールを設定し、直接プッシュが止まるかを確認します。

### ■ 検証内容：ルールを設定したmainへの直接プッシュ

GitHubのリポジトリの設定で、`main`にブランチ保護のルールを作成します。作成画面で、対象のブランチに`main`を指定し、プルリクエストを通さない変更をmainに入れないための「Require a pull request before merging」を有効にします。有効にすると、その下の「Require approvals」も既定で有効になりました。作成画面の上部には、「Your rules won't be enforced on this private repository until you move to a GitHub Team or Enterprise organization account.」という警告が表示されています。

![ブランチ保護のルールの作成画面（強制されないという警告と、mainに設定した項目）](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/section5-rule-create.png)

同じ画面の下部で、管理者にもルールを適用するための「Do not allow bypassing the above settings」を有効にします。それ以外の項目は有効にしていません。

![管理者にもルールを適用する設定](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/section5-rule-bypass.png)

ルールを作成すると、一覧では`main`のルールの横に「Not enforced」と表示され、作成画面と同じ趣旨の警告が表示されました。

![作成後のブランチ保護のルールの一覧（Not enforced）](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/section5-not-enforced.png)

画面の上では、ルールは作成できたものの、強制されていない状態です。この状態で、ファイルを何も変えない空のコミットを作り、プルリクエストを通さずにmainへ直接プッシュします。

**実行コマンド**

```plaintext
git commit --allow-empty -m "GitOps第3回: 検証用の空コミット（ブランチ保護を設定したmainへの直接プッシュ）"
```

**▼ 実行結果**

```plaintext
[main a60da73] GitOps第3回: 検証用の空コミット（ブランチ保護を設定したmainへの直接プッシュ）
```

**実行コマンド**

```plaintext
git log --oneline -2
```

**▼ 実行結果**

```plaintext
a60da73 (HEAD -> main) GitOps第3回: 検証用の空コミット（ブランチ保護を設定したmainへの直接プッシュ）
dfaf6de (origin/main) GitOps第3回: .gitignoreを追加
```

手元のmainだけが1つ先に進み、GitHub上のmain（`origin/main`）はまだ`dfaf6de`を指しています。この状態で、mainへ直接プッシュします。

**実行コマンド**

```plaintext
git push origin main; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
Enumerating objects: 1, done.
Counting objects: 100% (1/1), done.
Writing objects: 100% (1/1), 303 bytes | 151.00 KiB/s, done.
Total 1 (delta 0), reused 0 (delta 0), pack-reused 0
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
   dfaf6de..a60da73  main -> main
exit_code=0
```

GitHub上のmainが、どのコミットを指しているかを直接問い合わせます。

**実行コマンド**

```plaintext
git ls-remote origin refs/heads/main
```

**▼ 実行結果**

```plaintext
a60da73d6e575a52cb9d474ad70d1cb105be6a05        refs/heads/main
```

### ■ 結果

プルリクエストを通さない直接プッシュは拒否されず、`dfaf6de..a60da73  main -> main`として受け付けられました（`exit_code=0`）。拒否を示す`remote:`の行も出ていません。`git ls-remote`でも、GitHub上のmainは空のコミット（`a60da73`）を指しています。

管理者にもルールを適用する設定を有効にしていたため、この結果は、管理者だからルールを免除されたのではなく、ルールそのものが強制されていないことによるものです。画面の「Not enforced」の表示と一致します。

つまり、この検証環境のように、ブランチ保護が強制されない条件の非公開リポジトリでは、ルールを作成できても、mainへの直接プッシュは止まりません。ルールを作成したことで守られていると考えると、実際には守られていない状態を見落とすことになります。

### 強制する場所を適用前に移す

mainへの直接プッシュを止められない以上、プルリクエストを通っていないコミットがmainに入ることは、前提として受け入れます。そのうえで、GitOpsで守りたいのは、mainに入るコミットそのものではなく、インフラに届く変更です。そこで、確認する場所を「mainに入る前」から「インフラに適用する前」に移します。

```
変更をmainにプッシュする
　↓　← ブランチ保護で止める場所（この検証環境では止まらない）
mainにコミットが入る
　↓　← 適用するワークフローで、プルリクエストを通っていないコミットを適用しない
インフラに適用する
```

適用するワークフローの側で、適用しようとするコミットがプルリクエストを通ってmainに入ったものかを確認し、そうでなければ適用しません。直接プッシュされたコミットはmainに残りますが、インフラには届きません。強制する場所が変わっても、守る対象であるインフラに届く変更は変わりません。この確認の実装は、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** と **[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** で行います。

ブランチ保護が強制されるリポジトリであれば、mainに入る前の段階でも止められます。その場合でも、ルールは既定では管理者に適用されないため、適用前の確認を重ねて置くことで、mainに入る前の確認をすり抜けたコミットもインフラに届かなくなります。

### 手動変更の経路との関係

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション7では、Gitを経由しない手動変更に対して、変更の経路をGitに限定し、Gitを通った変更だけが適用される仕組みを第2部で作ると整理しました。この回のブランチ運用は、その仕組みの最初の手段です。インフラに届く変更を、プルリクエストを通ってmainに入ったコミットに限ることで、Gitの中でも経路を1つに絞ります。

ただし、**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** で整理したとおり、管理対象に直接入って変更する操作そのものは、ブランチの運用でもパイプラインでも止められません。そうした変更は、第4部（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** 〜 **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**）の検知と収束で扱います。

### 補足：ブランチ保護が強制される条件

この検証の結果は、ルールの設定漏れによるものではなく、リポジトリの条件によるものです。GitHubの公式ドキュメントでは、ブランチ保護もルールセットも、公開リポジトリではどのプランでも使え、非公開リポジトリでは上位のプランが必要とされています。

* ブランチ保護：**[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)**
* ルールセット：**[About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)**

どのプランで強制されるかについては、作成画面の警告が案内する条件と、公式ドキュメントの記述が完全には一致していません。自分のリポジトリでルールが強制されるかは、プランの名前から判断せず、ルールを作成した後の一覧で「Not enforced」と表示されていないかを確認します。

次のセクションでは、ここまでの設計と、この検証環境のリポジトリの現状の構成を比べます。

---

[↑ 目次に戻る](#-目次)

---

## 6. 既存リポジトリの構成を確認する

この検証環境のリポジトリの現状の構成を確認し、**[セクション2](#2-変更の分類をパスで表現する)** から **[セクション5](#5-mainを唯一の真実にするブランチ運用)** までの設計との差分を整理します。

### ■ 検証内容：現状の構成とパスの参照

まず、Gitで管理しているファイルを一覧にします。

**実行コマンド**

```plaintext
git ls-files
```

**▼ 実行結果**

```plaintext
.ansible-lint
.github/workflows/drift-check.yml
.github/workflows/e2e-provisioning-test.yml
.gitignore
.terraform.lock.hcl
Dockerfile
Dockerfile.deploy_nopasswd
Dockerfile.deploy_passwd
Dockerfile.legacy
ansible.cfg
dynamic_inventory.py
group_vars_target_nodes.tftpl
id_ed25519.pub
inventory.tftpl
main.tf
outputs.tf
requirements.yml
roles/common_setup/tasks/drift_check.yml
roles/common_setup/tasks/main.yml
site.yml
test_target_node1.py
```

`.github/workflows/`と`roles/`を除き、すべてのファイルがリポジトリのルートに置かれています。

次に、`main.tf`が、どのファイルをどの場所から読み、どこに書き出しているかを確認します。

**実行コマンド**

```plaintext
grep -n -E 'path\.module|context|dockerfile' main.tf
```

**▼ 実行結果**

```plaintext
27:    context    = "."
28:    dockerfile = "Dockerfile"
37:    context    = "."
38:    dockerfile = "Dockerfile.deploy_nopasswd"
48:    context    = "."
49:    dockerfile = "Dockerfile.deploy_passwd"
59:    context    = "."
60:    dockerfile = "Dockerfile.legacy"
104:    content = "${file("${path.module}/id_ed25519.pub")}\n${tls_private_key.generated.public_key_openssh}"
123:  filename = "${path.module}/inventory.ini"
124:  content = templatefile("${path.module}/inventory.tftpl", {
132:  filename = "${path.module}/group_vars/target_nodes.yml"
133:  content = templatefile("${path.module}/group_vars_target_nodes.tftpl", {
153:  filename = "${path.module}/id_ed25519_generated"
158:    command = "chmod 0600 ${path.module}/id_ed25519_generated"
```

Ansibleの側が、Terraformの生成したファイルや実行結果を、どう参照しているかを確認します。

**実行コマンド**

```plaintext
cat -n ansible.cfg
```

**▼ 実行結果**

```plaintext
     1  [defaults]
     2  host_key_checking = False
     3  private_key_file = ./id_ed25519_generated
```

**実行コマンド**

```plaintext
cat -n dynamic_inventory.py
```

**▼ 実行結果**

```plaintext
     1  #!/usr/bin/env python3
     2  import json
     3  import subprocess
（途中省略：4〜7行目のコメントアウトされた行）
     8  result = subprocess.run(
     9      ["terraform", "output", "-json", "target_nodes"],
    10      capture_output=True, text=True
    11  )
    12  nodes = json.loads(result.stdout)
    13  inventory = {
    14      "target_nodes": {
    15          "hosts": list(nodes.keys())
    16      },
    17      "_meta": {
    18          "hostvars": {
    19              name: {
    20                  "ansible_host": v["host"],
    21                  "ansible_port": v["port"],
    22                  "ansible_user": "ansible"
    23              }
    24              for name, v in nodes.items()
    25          }
    26      }
    27  }
    28  print(json.dumps(inventory))
```

ワークフローのステップに、作業ディレクトリの指定があるかを確認します。

**実行コマンド**

```plaintext
grep -n -E 'working-directory|defaults:' .github/workflows/*.yml; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
exit_code=1
```

最後に、残る2つのファイルがどのツールのものかを確認します。

**実行コマンド**

```plaintext
cat -n requirements.yml
cat -n .ansible-lint
```

**▼ 実行結果**

```plaintext
     1  collections:
     2    - name: community.docker
     3      version: ">=3.0.0"
     1  ---
     2  skip_list:
     3    - no-relative-paths
```

### ■ 結果

現状のファイルを、**[セクション2](#2-変更の分類をパスで表現する)** の「そのファイルを読むツール」で分けると、次のとおりです。

|分類|セクション2の設計での置き場所|現状|
|---|---|---|
|Terraformが読むファイル|`terraform/`|`main.tf`、`outputs.tf`、`inventory.tftpl`、`group_vars_target_nodes.tftpl`、`Dockerfile`と`Dockerfile.*`の3つ、`id_ed25519.pub`、`.terraform.lock.hcl`|
|Ansibleが読むファイル|`ansible/`|`site.yml`、`roles/common_setup/`、`ansible.cfg`、`dynamic_inventory.py`、`requirements.yml`（Ansibleのコレクションの定義）、`.ansible-lint`（ansible-lintの設定）|
|パイプラインの定義|`.github/workflows/`|`drift-check.yml`、`e2e-provisioning-test.yml`（設計と同じ）|
|Gitに置かないものの境界|ルートの`.gitignore`|**[セクション3](#3-gitに置くものと置かないもの)** で追加した`.gitignore`（設計と同じ）|
|どちらのツールも読まないファイル|（セクション2のツリーにない）|`test_target_node1.py`|

`test_target_node1.py`は、Ansible×Terraformシリーズの **[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)** で扱ったTestinfraのテストで、TerraformもAnsibleも読みません。

パイプラインの定義と`.gitignore`は、設計どおりの場所にあります。差分は、TerraformとAnsibleのファイルが分かれずに、同じルートに置かれていることです。

### ツールをまたいでいるのはGitの外の接続面だけ

参照の向きを見ると、Gitで管理しているファイル同士は、ツールをまたいで参照していません。`main.tf`が読むのはテンプレート、`Dockerfile`、`id_ed25519.pub`というTerraformの側のファイルで、Playbookやロールは読んでいません。Ansibleの側のファイルも、Terraformの側のファイルは読んでいません。**[セクション2](#2-変更の分類をパスで表現する)** で示した「ツールをまたいでファイルを参照しない」という条件は、現状の構成でも満たされています。

ツールをまたいでいるのは、次の2つの経路です。

```
main.tf（Terraform）
　↓ 123・132・153行目で、main.tfと同じ場所に書き出す
inventory.ini、group_vars/target_nodes.yml、id_ed25519_generated（Gitに置かない）
　↓ ansible.cfgの3行目、site.ymlと同じ場所のgroup_vars/から読む
ansible-playbook（Ansible）

dynamic_inventory.py（Ansible）
　↓ 9行目で、作業ディレクトリを指定せずにterraform outputを実行する
tfstate（Gitに置かない）
```

いずれも、**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション4で確認した、AnsibleとTerraformの接続面です。そして、**[セクション3](#3-gitに置くものと置かないもの)** で`.gitignore`によってGitの外に置いたファイルでもあります。今の構成でこの受け渡しが成り立っているのは、Terraformが書き出す場所、Ansibleが読む場所、`terraform`を実行する場所が、すべて同じルートだからです。ワークフローも、作業ディレクトリの指定がない（`exit_code=1`）ため、すべてのステップをルートで実行しています。

### 再配置は第5回で行う

`terraform/`と`ansible/`に分けると、この受け渡しがすべて同じルートにある前提が崩れます。再配置では、次の点を同時に決め直す必要があります。

* `docker_image`の`context = "."`（27〜59行目）の基準になる、`terraform`を実行する場所
* インベントリ、変数ファイル、生成した秘密鍵の書き出し先（123・132・153行目）と、Ansibleがそれを読む場所（`ansible.cfg`の3行目）
* `dynamic_inventory.py`が`terraform output`を実行する場所（9行目）
* ワークフローの各ステップの作業ディレクトリ

ワークフローには定期実行もあり、どれもmainのルートを前提にしているため、ファイルの移動とワークフローの修正は、同じコミットで行う必要があります。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** では、変更されたパスによるジョブの切り替えと、実行時のインベントリの生成を実装し、ワークフローを作り直します。再配置は、そのときにあわせて行います。この回では、差分と、再配置で決め直す点の洗い出しまでにとどめます。

次のセクションでは、プロバイダーを切り替えたときに、この構造のどこが変わり、どこが変わらないかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. プロバイダーを切り替えても変わる範囲

ここまでのリポジトリの構造が、TerraformのプロバイダーをAWSやGCPに切り替えたときに、どこが変わり、どこが変わらないかを整理します。

### プロバイダー固有の記述はterraform/に閉じる

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション8では、プロバイダーを切り替えるときに書き換わるのは、プロバイダーブロックとリソース定義であることを整理しました。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション6では、仮想マシンの中身をイメージに焼く手段が、Dockerでは`Dockerfile`から作るイメージ、AWSではAMI、GCPではマシンイメージに対応することを示しました。

これらはいずれも、**[セクション2](#2-変更の分類をパスで表現する)** の基準では「Terraformが読むファイル」であり、`terraform/`に置くものです。

```
（リポジトリのルート）
├─ .github/workflows/　　変わらない
├─ terraform/　　　　　　プロバイダー固有の記述はここに閉じる（プロバイダーブロック、リソース定義、イメージの定義）
└─ ansible/　　　　　　　置くファイルの役割は変わらない
```

AWSやGCPに切り替えたときに書き換えるのは、`terraform/`の中身です。`.terraform.lock.hcl`も、使うプロバイダーが変わるため内容が変わりますが、`terraform/`に置くファイルであることは変わりません。

### 変わらないもの

プロバイダーを切り替えても、この回で設計した次のものは変わりません。

|設計|プロバイダーを切り替えたとき|
|---|---|
|`terraform/`と`ansible/`の分け方（**[セクション2](#2-変更の分類をパスで表現する)**）|変わらない。分ける基準は、プロバイダーではなく、そのファイルを読むツール|
|変更されたパスと最初に行う判定の対応（**[セクション2](#2-変更の分類をパスで表現する)**）|変わらない。`terraform/`配下を含む変更は、プロバイダーを問わず`terraform plan`の結果でAnsibleの要否を決める|
|Gitに置くものと置かないものの境界（**[セクション3](#3-gitに置くものと置かないもの)**）|tfstate、生成したインベントリ、生成した秘密鍵を置かないことは変わらない。クラウドの認証情報のファイルをリポジトリの中に置く場合は、それも`.gitignore`の対象に加わる|
|モノレポの選択（**[セクション4](#4-モノレポとマルチリポの選択基準)**）|変わらない。両方にまたがる変更を1つのコミットで扱う必要は、プロバイダーと関係しない|
|mainを唯一の真実とするブランチ運用と、強制する場所（**[セクション5](#5-mainを唯一の真実にするブランチ運用)**）|変わらない。GitHubの側の運用であり、Terraformのプロバイダーと関係しない|
|Gitの外にある接続面の受け渡し（**[セクション6](#6-既存リポジトリの構成を確認する)**）|変わらない。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション6で整理したとおり、クラウドでもIPアドレスは作成時に割り当てられ、tfstateから接続先を生成する|

**[セクション2](#2-変更の分類をパスで表現する)** の表で、`terraform/`配下の変更が`terraform plan`の結果を見るまでAnsibleの要否を決められないのも、プロバイダーを問いません。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション6で確認したとおり、どの属性の変更が作り直しになるかはプロバイダーと属性によって異なり、判定は`terraform plan`に`must be replaced`が現れるかどうかで行います。

クラウドの認証情報をパイプラインの中でどう渡すかは、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

プロバイダーを切り替えて変わるのは、`terraform/`の中の、どのサービスのどのリソースをどの属性で作るかという記述です。リポジトリの構造、パスと判定の対応、Gitに置くものと置かないものの境界、ブランチの運用は、プロバイダーを問わず同じ形で使えます。

次のセクションでは、この回で整理した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

* ディレクトリ構成は、見た目の整理ではなく、コミットされた変更に対して、パイプラインがどのツールの判定から始めるかを決めるための入力である。ファイルはそれを読むツールで`terraform/`と`ansible/`に分け、`ansible/`配下だけの変更はTerraformの判定を省き、`terraform/`配下を含む変更は`terraform plan`の結果でAnsibleの要否を決める
* この対応は、Gitで管理するファイルがツールをまたいで参照し合わない場合に限って成り立つ
* Gitに置くかどうかは、ツールが生成したファイルかどうかではなく、中身が「決めたこと」か「実行の結果」かで決まる。tfstate、生成したインベントリ、生成した秘密鍵は置かず、`.terraform.lock.hcl`は置く。決めたことでも、パスワードのような秘密の値は置かない
* 除外の設定を`.gitignore`としてリポジトリに含めると、クローンした別の作業ディレクトリでも除外が効くことを実機で確認した。`.gitignore`はすでにコミットしたファイルには効かないため、過去の履歴に置かないはずのファイルがないことも確認した
* モノレポとマルチリポは、両方にまたがる変更を1つのコミットで扱う必要があるかと、ツールごとに変更できる人を分ける必要があるかの2つの基準で選ぶ。本シリーズは、同じ人がどちらのコードも変更できる運用を前提に、モノレポを採用する
* mainを唯一の真実とし、変更はプルリクエストを通してmainに入れることを原則とする。この検証環境の非公開リポジトリでは、ブランチ保護のルールを作成できても強制されず、管理者にも適用する設定を有効にしても、mainへの直接プッシュが受け付けられることを実機で確認した
* mainへの直接プッシュを止められないため、強制する場所を「mainに入る前」から「インフラに適用する前」に移す。守る対象であるインフラに届く変更は変わらない
* 検証環境のリポジトリは、TerraformとAnsibleのファイルがすべてルートに置かれている。Gitで管理するファイル同士はツールをまたいでいないが、Gitの外にある接続面は、同じルートにあることを前提に受け渡している。再配置は、ワークフローの作り直しとあわせて第5回で行う
* プロバイダー固有の記述は`terraform/`に閉じ、AWSやGCPに切り替えても、リポジトリの構造、パスと判定の対応、Gitに置くものと置かないものの境界、ブランチの運用は変わらない

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

本シリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** では、AnsibleとTerraformの責務分担を「変更の種類ごとに必要な実行」として捉え直し、どのツールの実行が必要になるかは変更したファイルからは決まらず、`terraform plan`の結果から見分けられることを確認しました。第3回となる今回は、その変更の分類を、Gitリポジトリの構造に落とし込みました。ディレクトリ構成を、パイプラインがどのツールの判定から始めるかを決める入力として設計し、Gitに置くものと置かないものの境界を`.gitignore`で引きました。そのうえで、モノレポとマルチリポの選択基準を示し、mainを唯一の真実とするブランチ運用では、ブランチ保護のルールが強制されない場合があることを実機で確認して、強制する場所を適用前に移す方針を示しました。最後に、検証環境のリポジトリの構成を確認し、プロバイダーを切り替えても構造が変わらないことを整理しました。

次回は、この構造のリポジトリを、どこでホストし、どこでパイプラインを動かすかを扱います。ローカルに置くGiteaとGitHub Actionsを、到達性、状態の永続性、機密情報の置き場所、運用負荷の4つの基準で比較し、選択が信頼境界の要件で決まることを示します。本シリーズは、GitHubと、管理対象と同じネットワーク内に置くself-hostedランナーを採用します。この回で前提にした、リポジトリを非公開で運用する理由も、次回の基準から整理します。

**[次回：第4回：ローカルGitea vs GitHub Actionsの選択基準](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)　｜　[次の記事：【GitOps編】第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第1部まとめブログ：「Gitが唯一の真実」を成り立たせる前提の設計** **※近日公開予定**

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

---

[↑ 目次に戻る](#-目次)

---