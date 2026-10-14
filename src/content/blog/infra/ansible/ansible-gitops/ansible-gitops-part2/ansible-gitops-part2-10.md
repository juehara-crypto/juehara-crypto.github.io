---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第10回：複数環境（dev/stg/prod）へのデプロイを分岐させる'
description: '環境をブランチではなく、mainの1本と環境ごとのディレクトリで分け、環境の違いを同じコードに渡す値の違いとして表現する。tfstateとインベントリを環境ごとに分け、ある環境に向けた実行がほかの環境に届かないことを確かめたうえで、dev→stg→prodの昇格の順序と条件を承認ゲートの入口で強制し、環境ごとに最後に適用したコミットを記録する。削除と作り直しは、devでは通し、stgとprodでは人が明示して許可する。'
pubDate: 2026-10-11
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'GitHub Actions', '複数環境']
seriesId: 'ansible-gitops-part2'
seriesNo: 10
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/'
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
2. [ブランチで分けるかディレクトリで分けるか](#2-ブランチで分けるかディレクトリで分けるか)
3. [tfstateを環境ごとに分ける](#3-tfstateを環境ごとに分ける)
4. [インベントリと変数を環境ごとに分ける](#4-インベントリと変数を環境ごとに分ける)
5. [昇格の順序と条件をワークフローで強制する](#5-昇格の順序と条件をワークフローで強制する)
6. [クラウドでは接続先と認証情報が変わるだけ](#6-クラウドでは接続先と認証情報が変わるだけ)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#9-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

TerraformとAnsibleのコードをGitで管理し、dev・stg・prodの3つの環境を運用していて、

* 環境ごとに、dev・stg・mainのブランチを用意した
* 変更は、devからstg、stgからmainへと、マージで順に進めていけば、各環境に反映される
* よって、環境の分け方はブランチで十分

と考えていないでしょうか。

複数の環境へのデプロイを扱う記事の多くは、環境ごとにブランチを分け、マージでブランチを順に進める構成を前提にしています。また、環境ごとの承認や設定の切り替えに、GitHubの環境（Environments）の機能を使う例が多く見られます。この機能のうち、承認する人を指定する「Required reviewers」は、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション5で確認したとおり、リポジトリの条件によっては使えません。AnsibleとTerraformのパイプラインを、環境ごとのブランチで運用し始めると、次のような場面にぶつかります。

* devのブランチにだけ入った修正が、prodのブランチに入っていない
* prodのブランチに直接入れた緊急の修正が、devのブランチに戻っていない
* devのつもりで、prodのtfstateやインベントリに対して実行した
* stgで確認していない変更が、prodに適用された

これらは、マージの手順や、運用ルールの守り方の問題に見えます。共通しているのは、環境ごとにブランチを持つと、どの環境にどのコードが入っているかがブランチの数だけ分かれ、Gitの上で1つに定まらなくなる点です。そして、どの環境に、どの順序で、どのコミットを届けたかが、パイプラインの構造として記録されていない点です。

コードの共通化は、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）で扱ってきました。Ansible×Terraformシリーズの **[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)** では、TerraformのモジュールとAnsibleのロールで共通部分を1か所にまとめ、呼び出し側には差分だけを残す構造を作りました。同じ回では、共通部分への変更が、それを参照するすべての呼び出し元に一括で及ぶことを確認し、誰が共通部分を変更してよいかという運用ルールが必要になる、という課題の所在を示すにとどめています。Ansible×Terraformシリーズの検証は、1つの環境の上で行っており、環境を複数に分ける構成は扱っていません。

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション7では、第4部で「mainブランチ」「実際にインフラへ反映した最後のコミット」「実際の状態」の3つを区別すると整理しました。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** では、AnsibleとTerraformのコードを1つのリポジトリにまとめ、mainを唯一の真実とするブランチ運用を設計しました。同じ回のセクション5では、環境ごとにブランチを分ける運用はとらないとし、環境の分け方をこの回に送っています。また、mainへの直接プッシュを止められないため、強制する場所を「mainに入る前」から「インフラに適用する前」に移す方針を示しました。

第2部では、この方針の上にパイプラインを積み上げてきました。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** では、プルリクエストで確認し、マージで適用する骨格を組みました。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** では、tfstateをpgバックエンドに移し、パイプラインの実行を直列化しました。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、マージで作ったplanを承認待ちとして保存し、手動の起動を承認とする承認ゲートを作りました。**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** と **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** では、AnsibleとTerraformの両側にガードレールを置き、承認ゲートの入口で、チェックの結果とplanの判定を確かめる構成にしました。

ただし、これらはすべて、操作対象が1つの環境であることを前提にしています。tfstateも、承認待ちも、作り直しと削除を許可する`allow_destroy`の判断も、1組しかありません。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション5では、承認待ちを破棄した変更が、mainにはあるが適用されていない差分として残ることを確認し、mainと最後に適用した内容の差を記録する仕組みを、この回で導入するとしました。**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** の次回予告では、同じ作り直しでも、開発用の環境なら許してよく、本番の環境では慎重に扱いたいという違いに触れています。

第10回となる今回は、ここまで1つの環境に積み上げてきたパイプラインを、dev・stg・prodの3つの環境に広げます。まず、環境をブランチで分ける構成と、mainの1本に環境ごとのディレクトリを置く構成を比べ、後者を採る理由を示します。次に、tfstateを環境ごとに分け、検証環境に3つの環境を用意します。そのうえで、環境ごとのtfstateから環境ごとのインベントリを作り、ある環境に向けた実行が、ほかの環境に届かないことを確かめます。最後に、変更をdev→stg→prodの順に適用させる昇格の順序と条件を、承認ゲートの入口で確かめる構成を作り、環境ごとに「最後に適用したコミット」を記録する仕組みを導入します。**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** の、削除と作り直しを止めるplanの判定は、環境によって扱いを変え、devでは通し、stgとprodでは人が明示して許可する形にします。GitHubの環境（Environments）の機能は、リポジトリの条件によっては同じことを作る別の方法になりますが、この回では検証せず、違いに触れるにとどめます。

正確に言うと、**環境の数だけブランチを持つと、環境の数だけ「真実」ができます。環境の違いは、ブランチの違いではなく、同じコードに渡す値の違いとして表現する必要があります**。この回で扱う問いは、「同じコードを、環境ごとに正しい順序で、正しい相手にだけ適用するには、何を環境ごとに分け、何を共有すればよいのか」です。

次のセクションでは、環境をブランチで分ける構成と、ディレクトリで分ける構成を比較します。

---

[↑ 目次に戻る](#-目次)

---


## 2. ブランチで分けるかディレクトリで分けるか

環境をブランチで分ける構成と、mainの1本に環境ごとのディレクトリを置く構成を比べ、本シリーズが後者を採る理由を整理します。

### 環境ごとにブランチを持つ構成

1つ目は、環境ごとにブランチを持ち、変更をマージでブランチからブランチへ進めていく構成です。
```

devブランチ　→（マージ）→　stgブランチ　→（マージ）→　mainブランチ  
　　↓　　　　　　　　　　　　　↓　　　　　　　　　　　　　↓  
dev環境に適用　　　　　　　stg環境に適用　　　　　　　prod環境に適用

```

この構成では、それぞれのブランチの先頭が、その環境のあるべき状態になります。変更をprodに届けるには、devからstg、stgからmainへと、マージを2回重ねます。

一見すると、マージの順序がそのまま昇格の順序になり、分かりやすい構成です。しかし、運用を続けると、ブランチの間でコードがずれていきます。

* prodで障害が起き、mainのブランチに直接修正を入れた。その修正を、devとstgのブランチに戻し忘れた
* devのブランチで試した修正のうち、一部だけをstgに進めたかったため、コミットを選んで取り込んだ（cherry-pick）。どのコミットがどのブランチに入っているかが、ブランチごとに違ってくる
* 環境ごとに違う値（接続先や台数）を、それぞれのブランチのファイルに書いた。devからstgへのマージで、devの値までstgに運ばれないように、マージのたびに確認する必要がある

**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** で整理したとおり、「Gitが唯一の真実」と言えるのは、Gitに記述されている範囲の中だけです。環境ごとにブランチを持つ構成では、その「Gitに記述されている内容」がブランチの数だけあり、互いにずれていきます。どのブランチの内容が正しいのかは、Gitの上では決まりません。

この回までのパイプラインとの関係も、問題になります。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で、mainを唯一の真実とし、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** から **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** では、承認ゲートの入口で、適用するmainのコミットについて、プルリクエストを通ったか、チェックが成功したか、planの判定を通るかを確かめてきました。環境ごとにブランチを持つと、この「mainのコミット」が環境の数だけに分かれ、入口の確認も、ブランチごとに用意し直すことになります。

### mainの1本に、環境ごとのディレクトリを置く構成

2つ目は、ブランチはmainの1本のままにし、環境ごとの違いを、リポジトリの中のディレクトリで表す構成です。
```

mainブランチ（1本）  
　├─ 共通のコード  
　└─ 環境ごとのディレクトリ（dev、stg、prod）：環境ごとに違う値  
　　　　↓  
同じコミットを、dev→stg→prodの順に適用する

```

この構成では、どの環境も、同じmainのコミットのコードを使います。環境ごとに違うのは、そのコードに渡す値だけです。昇格は、ブランチのマージではなく、「devに適用したのと同じコミットを、stgに適用する」という操作になります。

ブランチの間でコードがずれることは、構造上ありません。prodで障害が起きたときの修正も、mainへのプルリクエストとして入り、dev、stgと同じ経路でprodに届きます。環境ごとに違う値は、環境ごとのディレクトリにだけ書かれるため、マージで別の環境に運ばれることもありません。

一方で、この構成では、ブランチの構成で得ていたものが1つなくなります。ブランチの構成では、「どの環境にどのコードが入っているか」は、それぞれのブランチの先頭を見れば分かりました。mainの1本の構成では、mainの先頭は「これから適用するコード」を表すだけで、それぞれの環境に今どのコミットが適用されているかは、mainを見ても分かりません。そのため、環境ごとに「最後に適用したコミット」を、Gitの外に記録する必要があります。この記録は、**[セクション5](#5-昇格の順序と条件をワークフローで強制する)** で導入します。

また、mainに入ったコミットは、すべての環境のコードを同時に変えます。Ansible×Terraformシリーズの **[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)** で確認した、共通部分への変更がすべての呼び出し元に一括で及ぶ構造が、ここでは環境の単位で現れます。mainに入ったコミットを、一度にすべての環境に適用しないための仕組みが、昇格の順序と条件です。

### 2つの構成の比較

2つの構成を並べると、次のとおりです。

|観点|環境ごとのブランチ|mainの1本と環境ごとのディレクトリ|
|---|---|---|
|あるべき状態|ブランチの数だけあり、互いにずれていく|mainの1本に1つ|
|環境ごとの値|それぞれのブランチのファイルに書き、マージで運ばれないように確認する|環境ごとのディレクトリにだけ書く|
|昇格の操作|ブランチからブランチへのマージ|同じコミットを、次の環境に適用する|
|各環境に入っているコード|ブランチの先頭を見れば分かる|最後に適用したコミットを、別に記録する必要がある|
|承認ゲートの入口の確認|ブランチごとに用意し直す|mainのコミットに対して1つ|

### 本シリーズの採用

本シリーズは、mainの1本に環境ごとのディレクトリを置く構成を採ります。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で設計した、mainを唯一の真実とするブランチ運用と、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** から積み上げてきた承認ゲートの入口の確認を、そのまま使えるためです。

ディレクトリは、**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション2の基準（そのファイルを読むツールで分ける）を変えずに、`terraform/`と`ansible/`のそれぞれの中に環境ごとのディレクトリを置きます。
```

（リポジトリのルート）  
├─ .github/  
│　　├─ workflows/　　パイプラインの定義  
│　　└─ scripts/　　　planの判定のスクリプト  
├─ terraform/  
│　　├─ 共通のコード  
│　　└─ 環境ごとのディレクトリ（dev、stg、prod）　環境ごとの値と、tfstateの置き場所の指定  
└─ ansible/  
　　　├─ 共通のPlaybookとロール  
　　　└─ 環境ごとのディレクトリ（dev、stg、prod）　環境ごとの変数

```

`terraform/`の中の変更はTerraformの判定から、`ansible/`の中だけの変更はAnsibleの判定から始める、という **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のパスと判定の対応は、環境ごとのディレクトリを加えても保たれます。一方で、変更されたパスから、どの環境に適用するかは決めません。共通のコードの変更は、すべての環境に関わるためです。本シリーズでは、mainへのマージのたびに、すべての環境について承認待ちを作り、どの環境に、どの順序で適用するかは、**[セクション5](#5-昇格の順序と条件をワークフローで強制する)** の昇格の順序と条件で決めます。

このツリーの具体的な中身は、tfstateを分ける **[セクション3](#3-tfstateを環境ごとに分ける)** と、インベントリと変数を分ける **[セクション4](#4-インベントリと変数を環境ごとに分ける)** で、実機で確かめながら決めます。

次のセクションでは、tfstateを環境ごとに分け、検証環境に3つの環境を用意します。

---

[↑ 目次に戻る](#-目次)

---

## 3. tfstateを環境ごとに分ける

dev・stg・prodのtfstateを分ける方法を、Terraformのワークスペースと、環境ごとのディレクトリの2つで比べ、検証環境に3つの環境を用意します。

### ワークスペースで分ける方法

Terraformには、同じ設定のまま、複数のtfstateを切り替えて使うワークスペースの機能があります。`terraform workspace new`でワークスペースを作り、`terraform workspace select`で、どのtfstateを操作するかを選びます。まず、この方法で環境を分けたときの動きを確かめます。

#### ■ 検証内容：ワークスペースで環境を分けたときの動き

確認用のディレクトリを`/tmp`の下に作り、何も作らない`terraform_data`を1つだけ置きます。tfstateは、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** で用意したpgバックエンドに、確認用のスキーマ（`gitops10_ws_demo`）を指定して置き、既存の環境のtfstateには触れません。`input`には、選んでいるワークスペースの名前（`terraform.workspace`）を入れます。

**実行コマンド**

```plaintext
mkdir -m 700 /tmp/gitops10-ws && cd /tmp/gitops10-ws
cat > main.tf <<'EOF'
（ファイルの内容。下のcat -nの結果と同じ）
EOF
cat -n main.tf
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform init -input=false > /dev/null; echo "init_exit_code=$?"
terraform workspace new dev
terraform workspace new stg
terraform workspace list
cat .terraform/environment; echo
terraform workspace select dev
cat .terraform/environment; echo
terraform apply -auto-approve -input=false | tail -1
terraform workspace select stg
terraform apply -auto-approve -input=false | tail -1
terraform state show terraform_data.env | grep -E '^\s+(input|output)'
docker exec tfstate-pg psql -U terraform -d terraform_backend -c 'SELECT id, name, length(data) FROM gitops10_ws_demo.states ORDER BY id;'
```

**▼ 実行結果**

```plaintext
     1  terraform {
     2    backend "pg" {
     3      schema_name = "gitops10_ws_demo"
     4    }
     5  }
     6
     7  resource "terraform_data" "env" {
     8    input = terraform.workspace
     9  }
init_exit_code=0
Created and switched to workspace "dev"!

You're now on a new, empty workspace. Workspaces isolate their state,
so if you run "terraform plan" Terraform will not see any existing state
for this configuration.
Created and switched to workspace "stg"!

You're now on a new, empty workspace. Workspaces isolate their state,
so if you run "terraform plan" Terraform will not see any existing state
for this configuration.
  default
  dev
* stg

stg
Switched to workspace "dev".
dev
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
Switched to workspace "stg".
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
    input  = "stg"
    output = "stg"
 id | name | length
----+------+--------
 17 | dev  |    830
 18 | stg  |    830
(2 rows)
```

#### ■ 結果

* `terraform workspace new`は、作ったワークスペースにそのまま切り替えました。devとstgを続けて作った直後は、最後に作った`stg`が選ばれています
* どの環境を操作するかは、手元の`.terraform/environment`というファイルの1行で決まっていました。`.terraform/`は、**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション3で`.gitignore`の対象にしたディレクトリで、Gitには残りません。コードを見ても、どの環境を操作することになるかは分かりません
* 2つの環境のtfstateは、同じスキーマの同じテーブルに、`name`の違う行として並びました。接続先も、バックエンドの設定も、すべての環境で共通です
* `default`の行はありません。`default`のワークスペースでは、一度も適用していないためです

パイプラインのジョブは、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** のセクション2で確認したとおり、チェックアウトのたびにGitの外のファイルが掃除された場所で動きます。手元の`.terraform/environment`がない場所で初期化したときに、どのワークスペースが選ばれるかを確かめます。

#### ■ 検証内容：初期化し直したときのワークスペース

**実行コマンド**

```plaintext
cd /tmp/gitops10-ws
set -a; . ~/.config/tfstate-backend/backend.env; set +a
rm -rf .terraform
terraform init -input=false > /dev/null; echo "init_exit_code=$?"
terraform workspace show
terraform plan -input=false | grep -E 'input|Plan:'
```

**▼ 実行結果**

```plaintext
init_exit_code=0
default
      + input  = "default"
Plan: 1 to add, 0 to change, 0 to destroy.
```

確認用のリソース、ワークスペース、スキーマ、ディレクトリを削除します。

**実行コマンド**

```plaintext
for w in dev stg; do terraform workspace select "$w" > /dev/null; terraform destroy -auto-approve -input=false | tail -1; done
terraform workspace select default
terraform workspace delete dev
terraform workspace delete stg
terraform workspace list
cd ~
rm -rf /tmp/gitops10-ws
docker exec tfstate-pg psql -U terraform -d terraform_backend -c 'DROP SCHEMA gitops10_ws_demo CASCADE;'
docker exec tfstate-pg psql -U terraform -d terraform_backend -c '\dn'
ls -d /tmp/gitops10-ws; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
Destroy complete! Resources: 1 destroyed.
Destroy complete! Resources: 1 destroyed.
Switched to workspace "default".
Deleted workspace "dev"!
Deleted workspace "stg"!
* default

NOTICE:  drop cascades to table gitops10_ws_demo.states
DROP SCHEMA
              List of schemas
          Name          |       Owner
------------------------+-------------------
 public                 | pg_database_owner
 terraform_remote_state | terraform
(2 rows)

ls: cannot access '/tmp/gitops10-ws': No such file or directory
exit_code=2
```

#### ■ 結果

`.terraform/`を消して初期化し直すと、ワークスペースは`default`に戻りました。直前まで`stg`を選んでいた記録は、手元のファイルにしかなかったためです。そのまま実行した`plan`は、エラーにも警告にもならずに、`default`の環境に`input = "default"`のリソースを作る計画を出しました。

パイプラインのジョブでワークスペースを使う場合、どの環境を操作するかは、ジョブの中で毎回指定し直す必要があります。指定を忘れても、Terraformは止まらずに`default`の環境を操作します。**[セクション1](#1-はじめに)** で挙げた「devのつもりで、prodのtfstateに対して実行した」という場面は、ブランチだけでなく、この構造からも起こりえます。後片付けの結果、残っているスキーマは、既存の環境の`terraform_remote_state`と`public`だけです。

### 環境ごとのディレクトリとスキーマで分ける

本シリーズは、ワークスペースではなく、環境ごとのディレクトリでtfstateを分けます。環境ごとのディレクトリに、その環境のバックエンドの設定（tfstateを置くスキーマ）と、その環境の値の両方を書き、共通の部分はモジュールにまとめます。

```
terraform/
├─ modules/lab_env/　　共通のモジュール（イメージ、ネットワーク、鍵、コンテナ、出力値）
├─ envs/
│　　├─ dev/　　　　　スキーマterraform_remote_state_devと、devの値
│　　├─ stg/　　　　　スキーマterraform_remote_state_stgと、stgの値
│　　└─ prod/　　　　 スキーマterraform_remote_state（既存）と、prodの値
├─ Dockerfile ほか
└─ id_ed25519.pub
```

どの環境を操作するかは、`terraform`を実行するディレクトリで決まります。tfstateの置き場所と、その環境に渡す値は、同じディレクトリの同じファイルに書かれているため、「devの値で、prodのtfstateを操作する」という組み合わせは、ファイルを書き換えない限り作れません。どの環境を操作したかは、パイプラインの定義やログに、ディレクトリのパスとして残ります。

|観点|ワークスペース|環境ごとのディレクトリ|
|---|---|---|
|操作する環境を決めるもの|手元の`.terraform/environment`（Gitの外）|`terraform`を実行するディレクトリ|
|tfstateの置き場所|同じスキーマの、名前の違う行|環境ごとのスキーマ|
|バックエンドの設定|すべての環境で共通|環境ごとのディレクトリに書く|
|指定を忘れたとき|`default`の環境を操作する|実行する場所が決まらないため、始まらない|

環境ごとの値は、次のとおりにしました。prodは、今のtarget-node1〜3と、既存のtfstate（`terraform_remote_state`のスキーマ）をそのまま使い、devとstgは、コンテナを1台ずつ新しく作ります。Dockerのコンテナの名前は、同じホストの中で重複できないため、環境ごとに変えます。

|環境|コンテナと外部ポート|ネットワーク|tfstateのスキーマ|
|---|---|---|---|
|dev|`dev-node1`（2241）|`ansible-dev-net`|`terraform_remote_state_dev`|
|stg|`stg-node1`（2251）|`ansible-stg-net`|`terraform_remote_state_stg`|
|prod|target-node1〜3（2231、2222、2223）|`ansible-lab-net`|`terraform_remote_state`|

コンテナは、自分の環境のネットワーク1つだけに、`name`で参照してつなぎます。Ansible×Terraformシリーズの **[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** で確認したとおり、複数のネットワークにつなぐと、出力値が読む`network_data[0]`がどのネットワークのアドレスになるかが定まりません。また、**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** で確認したとおり、ネットワークを`id`で参照すると、ネットワークの作り直しがコンテナに波及します。

### ビルドの指定を変えただけで、コンテナまで作り直しになる

prodを`terraform/envs/prod`から実行するように移す前に、1つ確かめておくことがあります。イメージを作る`docker_image.ansible_target`は、`context = "."`で、`terraform`を実行する場所を基準に`Dockerfile`を探します。実行する場所が`terraform/envs/prod`に変わると、`Dockerfile`のある`terraform/`を指すように、`context`の書き方を変えることになります。

指す場所が同じでも、書き方の文字列が変わっただけで作り直しになるかを、移す前の`terraform/`で確かめます。`context`を、同じ場所を指す`"./"`に一時的に変えます。あわせて、ある環境のイメージを破棄したときにほかの環境のイメージを消さないよう、`keep_locally = true`を加えたときの扱いも確かめます。どちらも`plan`だけで、適用はしません。

#### ■ 検証内容：context と keep_locally の変更

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
sed -i '30s|context    = "."|context    = "./"|' main.tf
git --no-pager diff
terraform plan -input=false -no-color | grep -E '^  # |forces replacement|^Plan:'
git restore main.tf
sed -i '28a\  keep_locally = true' main.tf
git --no-pager diff
terraform plan -input=false -no-color | grep -E '^  # |forces replacement|^Plan:'
git restore main.tf
git status --short; echo "git_status_exit_code=$?"
```

**▼ 実行結果**

```plaintext
diff --git a/terraform/main.tf b/terraform/main.tf
index a8395d4..0eafbc2 100644
--- a/terraform/main.tf
+++ b/terraform/main.tf
@@ -27,7 +27,7 @@ variable "deploy_user_password" {
 resource "docker_image" "ansible_target" {
   name = "ansible-target:ubuntu22.04"
   build {
-    context    = "."
+    context    = "./"
     dockerfile = "Dockerfile"
     build_args = {
       ANSIBLE_USER_PASSWORD = var.ansible_user_password
  # docker_container.targets["target-node1"] must be replaced
      ~ image                                       = "sha256:35887767a57b8b99c30bdfc169c04a16a4786e3bbb124451d9d84972b65115f0" -> (known after apply) # forces replacement
  # docker_container.targets["target-node2"] must be replaced
      ~ image                                       = "sha256:35887767a57b8b99c30bdfc169c04a16a4786e3bbb124451d9d84972b65115f0" -> (known after apply) # forces replacement
  # docker_container.targets["target-node3"] must be replaced
      ~ image                                       = "sha256:35887767a57b8b99c30bdfc169c04a16a4786e3bbb124451d9d84972b65115f0" -> (known after apply) # forces replacement
  # docker_image.ansible_target must be replaced
      - build { # forces replacement
      + build { # forces replacement
Plan: 4 to add, 0 to change, 4 to destroy.
diff --git a/terraform/main.tf b/terraform/main.tf
index a8395d4..0d70317 100644
--- a/terraform/main.tf
+++ b/terraform/main.tf
@@ -26,6 +26,7 @@ variable "deploy_user_password" {
 # 1. SSHD入りの検証用Dockerイメージをビルド
 resource "docker_image" "ansible_target" {
   name = "ansible-target:ubuntu22.04"
+  keep_locally = true
   build {
     context    = "."
     dockerfile = "Dockerfile"
  # docker_image.ansible_target will be updated in-place
Plan: 0 to add, 1 to change, 0 to destroy.
git_status_exit_code=0
```

#### ■ 結果

`context`を`"."`から`"./"`に変えただけで、イメージは作り直し（`build { # forces replacement`）になりました。指しているのは同じ`terraform/`です。さらに、イメージの`image_id`を参照しているtarget-node1〜3も、3台とも作り直しの計画になりました（`Plan: 4 to add, 0 to change, 4 to destroy.`）。一方、`keep_locally = true`の追加は、その場での更新でした。

このまま`context`の書き方を変えてprodを移すと、コンテナが作り直され、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** で確認したとおり、Ansibleで入れた設定も失われます。実行する場所を変えただけで、です。

そこで、イメージには`lifecycle { ignore_changes = [build] }`を付け、`build`の差を作り直しの判定から外します。`context`には、`terraform/`を正しく指す値を渡します。そのかわり、`build`の中身（`Dockerfile`の名前や`build_args`）を変えても、イメージは作り直されなくなります。作り直したいときは、`terraform plan -replace`などで明示的に指定することになります。

イメージの名前は、環境ごとに変えます（prodは今の`ansible-target:ubuntu22.04`、devとstgは`ansible-target:ubuntu22.04-dev`と`ansible-target:ubuntu22.04-stg`）。同じ名前のイメージを複数の環境のtfstateが管理すると、ある環境でビルドし直したときに、ほかの環境のtfstateが記録しているイメージとずれるためです。

### prodを、作り直さずにモジュールへ移す

既存のtfstateを、prodのtfstateとして使います。既存のリソースは、`moved`ブロックで、モジュールの中のアドレスに付け替えます。Ansible×Terraformシリーズの **[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)** で確認したとおり、tfstateの記録だけを別の場所に移すと、記録とリソースの実体との対応がずれることがあります。`moved`ブロックは、同じtfstateの中で、記録のアドレスだけを付け替えます。

#### ■ 検証内容：モジュールとprodの環境を作り、planを確かめる

作業用のブランチを作り、ロックファイルをprodのディレクトリに移し、移す前の`main.tf`と`outputs.tf`を外します。手元のパスワードの変数ファイル（Gitの外）も、prodのディレクトリにコピーします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops10-envs
mkdir -p terraform/modules/lab_env terraform/envs/prod
git mv terraform/.terraform.lock.hcl terraform/envs/prod/.terraform.lock.hcl
git rm -q terraform/main.tf terraform/outputs.tf
ls -l terraform/terraform.tfvars
install -m 600 terraform/terraform.tfvars terraform/envs/prod/terraform.tfvars
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops10-envs'
-rw-rw-r-- 1 control control 67 Sep  3 10:45 terraform/terraform.tfvars
```

共通のモジュールを作ります。

**実行コマンド**

```plaintext
cat > terraform/modules/lab_env/main.tf <<'EOF'
（ファイルの内容。下のcat -nの結果と同じ）
EOF
cat > terraform/modules/lab_env/variables.tf <<'EOF'
（ファイルの内容。下のcat -nの結果と同じ）
EOF
cat > terraform/modules/lab_env/outputs.tf <<'EOF'
（ファイルの内容。下のcat -nの結果と同じ）
EOF
cat -n terraform/modules/lab_env/main.tf
cat -n terraform/modules/lab_env/variables.tf
cat -n terraform/modules/lab_env/outputs.tf
```

**▼ 実行結果**

```plaintext
     1  terraform {
     2    required_providers {
     3      docker = {
     4        source  = "kreuzwerker/docker"
     5        version = "~> 3.0.0"
     6      }
     7      tls = {
     8        source  = "hashicorp/tls"
     9        version = "~> 4.0"
    10      }
    11    }
    12  }
    13
    14  resource "docker_image" "this" {
    15    name         = var.image_name
    16    keep_locally = true
    17    build {
    18      context    = var.image_build_context
    19      dockerfile = "Dockerfile"
    20      build_args = {
    21        ANSIBLE_USER_PASSWORD = var.ansible_user_password
    22      }
    23    }
    24    lifecycle {
    25      ignore_changes = [build]
    26    }
    27  }
    28
    29  resource "docker_network" "this" {
    30    name = var.network_name
    31  }
    32
    33  resource "tls_private_key" "generated" {
    34    algorithm = "ED25519"
    35  }
    36
    37  resource "docker_container" "targets" {
    38    for_each = var.nodes
    39    name     = each.key
    40    image    = docker_image.this.image_id
    41    env      = []
    42    networks_advanced {
    43      name = docker_network.this.name
    44    }
    45    ports {
    46      internal = 22
    47      external = each.value
    48    }
    49    upload {
    50      file    = "/home/ansible/.ssh/authorized_keys"
    51      content = "${var.operator_public_key}\n${tls_private_key.generated.public_key_openssh}"
    52    }
    53    upload {
    54      file    = "/etc/init_marker"
    55      content = "init_version=v1\n"
    56    }
    57    lifecycle {
    58      ignore_changes = [network_mode]
    59    }
    60  }
     1  variable "nodes" {
     2    type        = map(number)
     3    description = "コンテナの名前と、外部に公開するSSHのポート"
     4  }
     5
     6  variable "network_name" {
     7    type        = string
     8    description = "コンテナをつなぐネットワークの名前"
     9  }
    10
    11  variable "image_name" {
    12    type        = string
    13    description = "コンテナのイメージの名前"
    14  }
    15
    16  variable "image_build_context" {
    17    type        = string
    18    description = "イメージのビルドで、Dockerfileを探す場所"
    19  }
    20
    21  variable "ansible_user_password" {
    22    type      = string
    23    sensitive = true
    24  }
    25
    26  variable "operator_public_key" {
    27    type        = string
    28    description = "authorized_keysに入れる、操作する人の公開鍵"
    29  }
     1  output "target_nodes" {
     2    value = {
     3      for name, container in docker_container.targets :
     4      name => {
     5        host = container.network_data[0].ip_address
     6        port = 22
     7      }
     8    }
     9  }
    10
    11  output "target_nodes_ips" {
    12    value = {
    13      for name, container in docker_container.targets :
    14      name => container.network_data[0].ip_address
    15    }
    16  }
    17
    18  output "generated_private_key" {
    19    value     = tls_private_key.generated.private_key_openssh
    20    sensitive = true
    21  }
    22
    23  output "network_name" {
    24    value = docker_network.this.name
    25  }
```

prodの環境は、次の2つのファイルです。`moved`ブロックで、イメージ、ネットワーク、鍵、コンテナを、モジュールの中のアドレスに付け替えます。どのコンテナも使っていない3つのイメージと`ansible-app-net`は、モジュールに入れずにprodの側に残します。管理の範囲の整理は、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)** の主題のため、この回では扱いません。

* **ファイル名：`terraform/envs/prod/main.tf`**

```hcl
terraform {
  required_version = "~> 1.15"
  backend "pg" {
    schema_name = "terraform_remote_state"
  }

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "docker" {}

variable "ansible_user_password" {
  type      = string
  sensitive = true
}

variable "deploy_user_password" {
  type      = string
  sensitive = true
}

module "lab_env" {
  source = "../../modules/lab_env"

  nodes = {
    "target-node1" = 2231
    "target-node2" = 2222
    "target-node3" = 2223
  }

  network_name          = "ansible-lab-net"
  image_name            = "ansible-target:ubuntu22.04"
  image_build_context   = "${path.module}/../.."
  ansible_user_password = var.ansible_user_password
  operator_public_key   = file("${path.module}/../../id_ed25519.pub")
}

moved {
  from = docker_image.ansible_target
  to   = module.lab_env.docker_image.this
}

moved {
  from = docker_network.lab_net
  to   = module.lab_env.docker_network.this
}

moved {
  from = tls_private_key.generated
  to   = module.lab_env.tls_private_key.generated
}

moved {
  from = docker_container.targets
  to   = module.lab_env.docker_container.targets
}

# 以下は、どのコンテナも使っていないリソース。管理の範囲の整理は第21回で扱う
resource "docker_image" "ansible_target_deploy_nopasswd" {
  name = "ansible-target:deploy-nopasswd"
  build {
    context    = "${path.module}/../.."
    dockerfile = "Dockerfile.deploy_nopasswd"
    build_args = {
      DEPLOY_USER_PASSWORD = var.deploy_user_password
    }
  }
  lifecycle {
    ignore_changes = [build]
  }
}

resource "docker_image" "ansible_target_deploy_passwd" {
  name = "ansible-target:deploy-passwd"
  build {
    context    = "${path.module}/../.."
    dockerfile = "Dockerfile.deploy_passwd"
    build_args = {
      DEPLOY_USER_PASSWORD = var.deploy_user_password
    }
  }
  lifecycle {
    ignore_changes = [build]
  }
}

resource "docker_image" "ansible_target_legacy" {
  name = "ansible-target:ubuntu18.04"
  build {
    context    = "${path.module}/../.."
    dockerfile = "Dockerfile.legacy"
    build_args = {
      ANSIBLE_USER_PASSWORD = var.ansible_user_password
    }
  }
  lifecycle {
    ignore_changes = [build]
  }
}

resource "docker_network" "app_net" {
  name = "ansible-app-net"
}
```

* **ファイル名：`terraform/envs/prod/outputs.tf`**

```hcl
output "target_nodes" {
  value       = module.lab_env.target_nodes
  description = "Ansible接続用のホスト、ポート情報（動的インベントリ用）"
}

output "target_nodes_ips" {
  value = module.lab_env.target_nodes_ips
}

output "generated_private_key" {
  value       = module.lab_env.generated_private_key
  sensitive   = true
  description = "Ansible接続用の秘密鍵（パイプラインのジョブで書き出す）"
}

output "network_name" {
  value       = module.lab_env.network_name
  description = "コンテナがつながっているネットワークの名前"
}
```

使われていない3つのイメージにも、`context`の修正と`ignore_changes = [build]`を加えています。手元のprodでは、これらのイメージはすでにあり、`context`の文字列が変わらなければ`plan`には現れません。しかし、`drift-check.yml`と`e2e-provisioning-test.yml`は、ホステッドランナーの中で、実行のたびにイメージを一からビルドします。`context = "."`のまま`terraform/envs/prod`で動かすと、`Dockerfile.legacy`などが見つからず、ビルドが失敗します。そこで、モジュールの中のイメージと同じ扱いにしました。

prodのディレクトリで初期化し、書式・構文と`plan`を確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform/envs/prod
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform init -input=false -lockfile=readonly > /dev/null; echo "init_exit_code=$?"
terraform fmt -check -recursive ../..; echo "fmt_exit_code=$?"
terraform validate -no-color; echo "validate_exit_code=$?"
terraform plan -input=false -no-color | grep -E '^  # |^  #  \(|forces replacement|^Plan:|No changes'
```

**▼ 実行結果**

```plaintext
init_exit_code=0
fmt_exit_code=0
Success! The configuration is valid.

validate_exit_code=0
  # docker_container.targets["target-node1"] has moved to module.lab_env.docker_container.targets["target-node1"]
  # docker_container.targets["target-node2"] has moved to module.lab_env.docker_container.targets["target-node2"]
  # docker_container.targets["target-node3"] has moved to module.lab_env.docker_container.targets["target-node3"]
  # module.lab_env.docker_image.this will be updated in-place
  # (moved from docker_image.ansible_target)
  # docker_network.lab_net has moved to module.lab_env.docker_network.this
  # tls_private_key.generated has moved to module.lab_env.tls_private_key.generated
Plan: 0 to add, 1 to change, 0 to destroy.
```

#### ■ 結果

コンテナ3台、ネットワーク、鍵は、`has moved to`として、アドレスの付け替えだけが計画されました。作り直し（`forces replacement`）は1つもありません。イメージは、付け替えに加えて、`keep_locally`の追加によるその場での更新です（`Plan: 0 to add, 1 to change, 0 to destroy.`）。`ignore_changes = [build]`によって、`context`の文字列の違いは、作り直しの判定に現れていません。使われていない3つのイメージと`ansible-app-net`も、計画に現れていません。

#### ■ 検証内容：パイプラインを、prodのディレクトリに向ける

ワークフローと`dynamic_inventory.py`は、どれも`terraform/`で`terraform`を実行する前提で書かれています。この段階では、パイプラインが扱う環境はprodだけのまま、`terraform/`を見ていたところを`terraform/envs/prod`に向けます。環境ごとに分けた承認と昇格は、**[セクション5](#5-昇格の順序と条件をワークフローで強制する)** で作ります。

ただし、書式のチェック（`gitops-pipeline.yml`の92行目）は、共通のモジュールも対象に含めるため、`terraform/`のまま残します。また、planの判定のスクリプトは、作業ディレクトリが1段深くなるため、リポジトリのルートを指す`$GITHUB_WORKSPACE`を基準にしたパスに変えます。`e2e-provisioning-test.yml`で鍵を作り直す`taint`の対象も、モジュールの中のアドレスに変えます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
sed -i 's|working-directory: terraform$|working-directory: terraform/envs/prod|' .github/workflows/gitops-pipeline.yml .github/workflows/gitops-apply.yml .github/workflows/drift-check.yml .github/workflows/e2e-provisioning-test.yml
sed -i '92s|working-directory: terraform/envs/prod$|working-directory: terraform|' .github/workflows/gitops-pipeline.yml
sed -i 's|-chdir=\.\./terraform |-chdir=../terraform/envs/prod |' .github/workflows/gitops-pipeline.yml .github/workflows/gitops-apply.yml .github/workflows/drift-check.yml .github/workflows/e2e-provisioning-test.yml
sed -i '142s|\.\./\.github/scripts/plan-policy\.sh|"$GITHUB_WORKSPACE"/.github/scripts/plan-policy.sh|' .github/workflows/gitops-apply.yml
sed -i '70s|terraform taint tls_private_key\.generated|terraform taint module.lab_env.tls_private_key.generated|' .github/workflows/e2e-provisioning-test.yml
sed -i '13s|"\.\.", "terraform")|"..", "terraform", "envs", "prod")|' ansible/dynamic_inventory.py
git --no-pager diff -- .github ansible
python3 -c 'import sys, yaml; [yaml.safe_load(open(f)) for f in sys.argv[1:]]; print("yaml ok")' .github/workflows/*.yml
grep -n -E 'working-directory: terraform|-chdir=|plan-policy|taint' .github/workflows/*.yml
```

**▼ 実行結果**

```plaintext
（途中省略：差分の表示）
yaml ok
.github/workflows/drift-check.yml:18:        working-directory: terraform/envs/prod
.github/workflows/drift-check.yml:26:        working-directory: terraform/envs/prod
.github/workflows/drift-check.yml:29:        working-directory: terraform/envs/prod
.github/workflows/drift-check.yml:47:          terraform -chdir=../terraform/envs/prod output -raw generated_private_key > id_ed25519_generated
.github/workflows/e2e-provisioning-test.yml:15:        working-directory: terraform/envs/prod
.github/workflows/e2e-provisioning-test.yml:23:        working-directory: terraform/envs/prod
.github/workflows/e2e-provisioning-test.yml:26:        working-directory: terraform/envs/prod
.github/workflows/e2e-provisioning-test.yml:32:        working-directory: terraform/envs/prod
.github/workflows/e2e-provisioning-test.yml:47:          terraform -chdir=../terraform/envs/prod output -raw generated_private_key > id_ed25519_generated
.github/workflows/e2e-provisioning-test.yml:69:        working-directory: terraform/envs/prod
.github/workflows/e2e-provisioning-test.yml:70:        run: terraform taint module.lab_env.tls_private_key.generated
.github/workflows/e2e-provisioning-test.yml:72:        working-directory: terraform/envs/prod
.github/workflows/e2e-provisioning-test.yml:78:        working-directory: terraform/envs/prod
.github/workflows/e2e-provisioning-test.yml:81:        working-directory: terraform/envs/prod
.github/workflows/gitops-apply.yml:132:        working-directory: terraform/envs/prod
.github/workflows/gitops-apply.yml:136:        working-directory: terraform/envs/prod
.github/workflows/gitops-apply.yml:142:          terraform show -json "$HOME/gitops-pending/tfplan" | "$GITHUB_WORKSPACE"/.github/scripts/plan-policy.sh || rc=$?
.github/workflows/gitops-apply.yml:164:        working-directory: terraform/envs/prod
.github/workflows/gitops-apply.yml:167:        working-directory: terraform/envs/prod
.github/workflows/gitops-apply.yml:181:        working-directory: terraform/envs/prod
.github/workflows/gitops-apply.yml:187:          terraform -chdir=../terraform/envs/prod output -raw generated_private_key > id_ed25519_generated
.github/workflows/gitops-pipeline.yml:89:        working-directory: terraform/envs/prod
.github/workflows/gitops-pipeline.yml:92:        working-directory: terraform
.github/workflows/gitops-pipeline.yml:95:        working-directory: terraform/envs/prod
.github/workflows/gitops-pipeline.yml:98:        working-directory: terraform/envs/prod
.github/workflows/gitops-pipeline.yml:101:        working-directory: terraform/envs/prod
.github/workflows/gitops-pipeline.yml:111:        working-directory: terraform/envs/prod
.github/workflows/gitops-pipeline.yml:114:        working-directory: terraform/envs/prod
.github/workflows/gitops-pipeline.yml:135:        working-directory: terraform/envs/prod
.github/workflows/gitops-pipeline.yml:141:          terraform -chdir=../terraform/envs/prod output -raw generated_private_key > id_ed25519_generated
```

パイプラインと同じ場所から、tflintとTrivy、直した`dynamic_inventory.py`を、手元で確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform/envs/prod
tflint; echo "tflint_exit_code=$?"
trivy config --quiet --misconfig-scanners terraform --exit-code 1 . 2>&1 | tail -8; echo "trivy_exit_code=${PIPESTATUS[0]}"
cd ~/iac/docker-lab-ci/ansible
ansible-inventory -i dynamic_inventory.py --graph
ansible-playbook -i dynamic_inventory.py site.yml --check 2>/dev/null | tail -4
```

**▼ 実行結果**

```plaintext
tflint_exit_code=0
│ Target │   Type    │ Misconfigurations │
├────────┼───────────┼───────────────────┤
│ .      │ terraform │         0         │
└────────┴───────────┴───────────────────┘
Legend:
- '-': Not scanned
- '0': Clean (no security findings detected)

trivy_exit_code=0
@all:
  |--@ungrouped:
  |--@target_nodes:
  |  |--target-node1
  |  |--target-node2
  |  |--target-node3
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

#### ■ 検証内容：プルリクエストと承認ゲートを通して、prodに適用する

この変更をコミットしてプッシュします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git add -A terraform .github ansible
git status --short
git commit -m "GitOps第10回: Terraformを共通のモジュールとprodの環境に分け、ワークフローをprodに向ける"
git push -u origin gitops10-envs
```

**▼ 実行結果**

```plaintext
M  .github/workflows/drift-check.yml
M  .github/workflows/e2e-provisioning-test.yml
M  .github/workflows/gitops-apply.yml
M  .github/workflows/gitops-pipeline.yml
M  ansible/dynamic_inventory.py
R  terraform/.terraform.lock.hcl -> terraform/envs/prod/.terraform.lock.hcl
A  terraform/envs/prod/main.tf
A  terraform/envs/prod/outputs.tf
D  terraform/main.tf
A  terraform/modules/lab_env/main.tf
A  terraform/modules/lab_env/outputs.tf
A  terraform/modules/lab_env/variables.tf
D  terraform/outputs.tf
[gitops10-envs ffb990c] GitOps第10回: Terraformを共通のモジュールとprodの環境に分け、ワークフローをprodに向ける
 13 files changed, 275 insertions(+), 187 deletions(-)
（途中省略：作成と削除の一覧、プッシュの表示）
```

手元のパスワードの変数ファイルと`.terraform/`は、`.gitignore`の対象のため、コミットに入っていません。このブランチから、プルリクエスト（`#51`）を作成しました。確認の実行は、「GitOps Pipeline」の`#93`です。

**▼ 実行結果（プルリクエスト`#51`の「GitOps Pipeline」の実行`#93`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
.github/workflows/drift-check.yml
.github/workflows/e2e-provisioning-test.yml
.github/workflows/gitops-apply.yml
.github/workflows/gitops-pipeline.yml
***/dynamic_inventory.py
terraform/envs/prod/.terraform.lock.hcl
terraform/envs/prod/main.tf
terraform/envs/prod/outputs.tf
terraform/main.tf
terraform/modules/lab_env/main.tf
terraform/modules/lab_env/outputs.tf
terraform/modules/lab_env/variables.tf
terraform/outputs.tf
base=51aa70f25fcdedfcf285b4e778a5f6fe3fc5ae11
terraform=true
***=true
```

ログの中の`***`は、`ansible`です。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション5で確認したとおり、この検証環境では、Secretsの値と一致する語が、ログの中で伏せられます。この回のログでは、`ansible`のほかに`deploy`も同じく伏せられています。

`terraform/`と`ansible/`の両方に変更があるため、`changes`、`ansible-lint`、`molecule`、`terraform-static`、`terraform-plan`、`ansible-check`が動き、`record-pending`だけがスキップされました。`terraform-static`は、`terraform/envs/prod`から実行して（書式のチェックは`terraform/`）、5つのステップがすべて成功しています。

**▼ 実行結果（「GitOps Pipeline」の実行`#93`、`terraform-plan`ジョブのステップ「Terraform plan」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力）
  # docker_container.targets["target-node1"] has moved to module.lab_env.docker_container.targets["target-node1"]
（途中省略：target-node1の内容の表示）
  # docker_container.targets["target-node2"] has moved to module.lab_env.docker_container.targets["target-node2"]
（途中省略：target-node2の内容の表示）
  # docker_container.targets["target-node3"] has moved to module.lab_env.docker_container.targets["target-node3"]
（途中省略：target-node3の内容の表示）
  # module.lab_env.docker_image.this will be updated in-place
  # (moved from docker_image.***_target)
  ~ resource "docker_image" "this" {
        id           = "sha256:35887767a57b8b99c30bdfc169c04a16a4786e3bbb124451d9d84972b65115f0***-target:ubuntu22.04"
      + keep_locally = true
        name         = "***-target:ubuntu22.04"
        # (2 unchanged attributes hidden)

        # (1 unchanged block hidden)
    }

  # docker_network.lab_net has moved to module.lab_env.docker_network.this
（途中省略：ネットワークの内容の表示）
  # tls_private_key.generated has moved to module.lab_env.tls_private_key.generated
（途中省略：鍵の内容の表示）
Plan: 0 to add, 1 to change, 0 to destroy.

Changes to Outputs:
  - lab_network_name      = "***-lab-net" -> null
  + network_name          = "***-lab-net"
（途中省略：-outオプションに関する注意書き）
```

**▼ 実行結果（「GitOps Pipeline」の実行`#93`、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）
PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

パイプラインの中の`plan`も、手元と同じ結果です。確認の実行が成功した後に、`#51`をマージしました（マージコミット`f69a1ae`）。マージで起動した「GitOps Pipeline」の実行`#94`で、承認待ちが記録されました。

**▼ 実行結果（`#51`のマージの「GitOps Pipeline」の実行`#94`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示、ファイルの一覧）
54b5768723ca2f4dd13f0d39c226e48711cc5e7b134abc6b3cabf2631038c0e9  tfplan
base=51aa70f25fcdedfcf285b4e778a5f6fe3fc5ae11
commit=f69a1aec9be4e3c2a56a72d1a81c8acf1fa9bb23
terraform=true
***=true
```

この承認待ちを、「GitOps Apply」を、ブランチ「main」、2つの入力を外したまま起動して適用しました（実行`#22`）。`discard`以外のジョブが、すべて成功しています。

**▼ 実行結果（「GitOps Apply」の実行`#22`、`verify`ジョブの入口の確認の各ステップから抜粋）**

```plaintext
（ステップ「Check commits came from pull requests」）
f69a1aec9be4e3c2a56a72d1a81c8acf1fa9bb23: merge of pull request #51
（ステップ「Check guardrail results」）
***-lint: success
molecule: success
（ステップ「Check terraform guardrail results」）
terraform-static: success
（ステップ「Check plan policy」）
54b5768723ca2f4dd13f0d39c226e48711cc5e7b134abc6b3cabf2631038c0e9  /home/control/gitops-pending/tfplan
PASS  module.lab_env.docker_image.this actions=update
policy: pass
```

**▼ 実行結果（「GitOps Apply」の実行`#22`、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
54b5768723ca2f4dd13f0d39c226e48711cc5e7b134abc6b3cabf2631038c0e9  /home/control/gitops-pending/tfplan
module.lab_env.docker_image.this: Modifying... [id=sha256:35887767a57b8b99c30bdfc169c04a16a4786e3bbb124451d9d84972b65115f0***-target:ubuntu22.04]
module.lab_env.docker_image.this: Modifications complete after 0s [id=sha256:35887767a57b8b99c30bdfc169c04a16a4786e3bbb124451d9d84972b65115f0***-target:ubuntu22.04]

Apply complete! Resources: 0 added, 1 changed, 0 destroyed.
（途中省略：Outputsの表示）
```

**▼ 実行結果（「GitOps Apply」の実行`#22`、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）
PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

planのハッシュ値は、承認待ちの記録（`#94`）、入口の判定、適用（`#22`）の3か所で、`54b57687...`のまま一致しています。planの判定に現れたのは、イメージの更新の1行だけでした。移動しただけのコンテナ、ネットワーク、鍵は、変更の種類が`no-op`のため、判定の出力には現れません。`moved`ブロックによる付け替えは、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** のplanの判定からは、何も起きない変更として扱われます。

手元で、終了時点の状態を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline -2
git branch -d gitops10-envs
git push origin --delete gitops10-envs
git branch -a
git status --short; echo "git_status_exit_code=$?"
ls -la ~/gitops-pending; echo "exit_code=$?"
cd terraform/envs/prod
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform init -input=false -lockfile=readonly > /dev/null; echo "init_exit_code=$?"
terraform state list
terraform plan -input=false -detailed-exitcode > /dev/null 2>&1; echo "plan_exit_code=$?"
for n in target-node1 target-node2 target-node3; do docker inspect -f '{{.Name}} id={{printf "%.12s" .Id}} ip={{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$n"; done
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えと、オブジェクトの受信の表示）
f69a1ae (HEAD -> main, origin/main) Merge pull request #51 from juehara-crypto/gitops10-envs
ffb990c (origin/gitops10-envs, gitops10-envs) GitOps第10回: Terraformを共通のモジュールとprodの環境に分け、ワークフローをprodに向ける
Deleted branch gitops10-envs (was ffb990c).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops10-envs
* main
  remotes/origin/main
git_status_exit_code=0
ls: cannot access '/home/control/gitops-pending': No such file or directory
exit_code=2
init_exit_code=0
docker_image.ansible_target_deploy_nopasswd
docker_image.ansible_target_deploy_passwd
docker_image.ansible_target_legacy
docker_network.app_net
module.lab_env.docker_container.targets["target-node1"]
module.lab_env.docker_container.targets["target-node2"]
module.lab_env.docker_container.targets["target-node3"]
module.lab_env.docker_image.this
module.lab_env.docker_network.this
module.lab_env.tls_private_key.generated
plan_exit_code=0
/target-node1 id=2ae67f98c381 ip=172.19.0.2
/target-node2 id=48305fbf396c ip=172.19.0.3
/target-node3 id=6e6e1fc26bdd ip=172.19.0.4
```

最後に、作業ディレクトリを直したホステッドランナーの2つのワークフローを、マージ後のmainで手動で起動しました。どちらも、ホステッドランナーの中で一から環境を作るもので、self-hostedランナーの操作対象には触れません。

**▼ 実行結果（「Drift Check」の実行`#210`、ステップ「Ansible Check Mode」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）
PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   

DEBUG: CHANGED value is [1]
```

**▼ 実行結果（「E2E Provisioning Test」の実行`#18`、ステップ「Run Testinfra」とステップ「Check for dangerous destroy-and-create actions」から抜粋）**

```plaintext
（ステップ「Run Testinfra」）
（途中省略：実行したスクリプト、シェル、環境変数の表示、テストの開始の表示）
tests/test_target_node1.py ......                                        [100%]

============================== 6 passed in 6.80s ===============================
（ステップ「Check for dangerous destroy-and-create actions」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
danger detected: 3 docker_container resource(s) planned for destroy-and-create
"module.lab_env.docker_container.targets[\"target-node1\"]"
"module.lab_env.docker_container.targets[\"target-node2\"]"
"module.lab_env.docker_container.targets[\"target-node3\"]"
Error: Process completed with exit code 1.
```

#### ■ 結果

prodの記録は、10個のリソースのうち6つが`module.lab_env.`の下のアドレスに移り、使われていない3つのイメージと`ansible-app-net`は元のアドレスのままです。`terraform plan`は差分なし（`plan_exit_code=0`）で、target-node1〜3のIDとIPアドレスは、作業の前と同じでした。構成を共通のモジュールと`terraform/envs/prod`に分けても、コンテナは1台も作り直されていません。

ホステッドランナーの2つのワークフローも、直した構成で動きました。「Drift Check」は、改ざんを注入したtarget-node1だけを`changed=1`として検知しました。「E2E Provisioning Test」の最後のステップは、鍵の作り直しをわざと起こし、コンテナの作り直しを検出して止まることを確かめるもので、失敗で終わるのは **[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** と同じ、想定どおりの結果です。検出されたアドレスは、モジュールの中のものになっています。

### dev・stgを用意する

dev・stgの環境を作ります。この時点のパイプラインは、prodの1つの環境しか扱えません。環境ごとの承認と昇格は **[セクション5](#5-昇格の順序と条件をワークフローで強制する)** で作るため、dev・stgは、パイプラインがまだ環境を扱えない段階での検証環境の準備として、手元から適用します。ただし、適用するコードはプルリクエストでmainに入れたものにそろえ、mainのコミットから適用します。

#### ■ 検証内容：dev・stgのファイルを作り、planを確かめる

devの`main.tf`を作り、stgの`main.tf`は、devの`dev`を`stg`に、ポートを2251に置き換えて作ります。`outputs.tf`とロックファイルは、prodと同じものをコピーします。dev・stgには使われていないイメージがないため、`deploy_user_password`の変数は宣言せず、手元のパスワードの変数ファイルも、`ansible_user_password`の行だけをコピーします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops10-envs-dev-stg
mkdir -p terraform/envs/dev terraform/envs/stg
cat > terraform/envs/dev/main.tf <<'EOF'
（ファイルの内容。下のcat -nの結果と同じ）
EOF
sed 's/dev/stg/g; s/2241/2251/' terraform/envs/dev/main.tf > terraform/envs/stg/main.tf
for e in dev stg; do
  cp terraform/envs/prod/outputs.tf terraform/envs/$e/outputs.tf
  cp terraform/envs/prod/.terraform.lock.hcl terraform/envs/$e/.terraform.lock.hcl
  (umask 077; grep '^ansible_user_password' terraform/terraform.tfvars > terraform/envs/$e/terraform.tfvars)
done
cat -n terraform/envs/dev/main.tf
diff terraform/envs/dev/main.tf terraform/envs/stg/main.tf
for e in dev stg; do echo "== $e"; ls -la terraform/envs/$e; cut -d= -f1 terraform/envs/$e/terraform.tfvars; done
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops10-envs-dev-stg'
     1  terraform {
     2    required_version = "~> 1.15"
     3    backend "pg" {
     4      schema_name = "terraform_remote_state_dev"
     5    }
     6
     7    required_providers {
     8      docker = {
     9        source  = "kreuzwerker/docker"
    10        version = "~> 3.0.0"
    11      }
    12      tls = {
    13        source  = "hashicorp/tls"
    14        version = "~> 4.0"
    15      }
    16    }
    17  }
    18
    19  provider "docker" {}
    20
    21  variable "ansible_user_password" {
    22    type      = string
    23    sensitive = true
    24  }
    25
    26  module "lab_env" {
    27    source = "../../modules/lab_env"
    28
    29    nodes = {
    30      "dev-node1" = 2241
    31    }
    32
    33    network_name          = "ansible-dev-net"
    34    image_name            = "ansible-target:ubuntu22.04-dev"
    35    image_build_context   = "${path.module}/../.."
    36    ansible_user_password = var.ansible_user_password
    37    operator_public_key   = file("${path.module}/../../id_ed25519.pub")
    38  }
4c4
<     schema_name = "terraform_remote_state_dev"
---
>     schema_name = "terraform_remote_state_stg"
30c30
<     "dev-node1" = 2241
---
>     "stg-node1" = 2251
33,34c33,34
<   network_name          = "ansible-dev-net"
<   image_name            = "ansible-target:ubuntu22.04-dev"
---
>   network_name          = "ansible-stg-net"
>   image_name            = "ansible-target:ubuntu22.04-stg"
== dev
total 24
drwxrwxr-x 2 control control 4096 Oct 11 03:13 .
drwxrwxr-x 5 control control 4096 Oct 11 03:13 ..
-rw-rw-r-- 1 control control  773 Oct 11 03:13 main.tf
-rw-rw-r-- 1 control control  602 Oct 11 03:13 outputs.tf
-rw-rw-r-- 1 control control 2485 Oct 11 03:13 .terraform.lock.hcl
-rw------- 1 control control   34 Oct 11 03:13 terraform.tfvars
ansible_user_password
== stg
total 24
drwxrwxr-x 2 control control 4096 Oct 11 03:13 .
drwxrwxr-x 5 control control 4096 Oct 11 03:13 ..
-rw-rw-r-- 1 control control  773 Oct 11 03:13 main.tf
-rw-rw-r-- 1 control control  602 Oct 11 03:13 outputs.tf
-rw-rw-r-- 1 control control 2485 Oct 11 03:13 .terraform.lock.hcl
-rw------- 1 control control   34 Oct 11 03:13 terraform.tfvars
ansible_user_password
```

devとstgの`main.tf`の違いは、tfstateのスキーマ、コンテナの名前とポート、ネットワーク、イメージの名前の4か所だけです。同じモジュールに、違う値を渡しているだけの形です。`cut`の行は、変数ファイルに`ansible_user_password`の変数名だけが入っていることの確認で、値は表示していません。

dev・stgのディレクトリで初期化し、書式・構文・tflintと、`plan`を確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform -chdir=terraform fmt -check -recursive; echo "fmt_exit_code=$?"
for e in dev stg; do
  echo "== $e"
  cd ~/iac/docker-lab-ci/terraform/envs/$e
  terraform init -input=false -lockfile=readonly > /dev/null; echo "init_exit_code=$?"
  terraform validate -no-color; echo "validate_exit_code=$?"
  tflint; echo "tflint_exit_code=$?"
  terraform plan -input=false -no-color | grep -E '^  # |^Plan:'
done
cd ~/iac/docker-lab-ci
docker exec tfstate-pg psql -U terraform -d terraform_backend -c '\dn'
git status --short
```

**▼ 実行結果**

```plaintext
fmt_exit_code=0
== dev
init_exit_code=0
Success! The configuration is valid.

validate_exit_code=0
tflint_exit_code=0
  # module.lab_env.docker_container.targets["dev-node1"] will be created
  # module.lab_env.docker_image.this will be created
  # module.lab_env.docker_network.this will be created
  # module.lab_env.tls_private_key.generated will be created
Plan: 4 to add, 0 to change, 0 to destroy.
== stg
init_exit_code=0
Success! The configuration is valid.

validate_exit_code=0
tflint_exit_code=0
  # module.lab_env.docker_container.targets["stg-node1"] will be created
  # module.lab_env.docker_image.this will be created
  # module.lab_env.docker_network.this will be created
  # module.lab_env.tls_private_key.generated will be created
Plan: 4 to add, 0 to change, 0 to destroy.
                List of schemas
            Name            |       Owner
----------------------------+-------------------
 public                     | pg_database_owner
 terraform_remote_state     | terraform
 terraform_remote_state_dev | terraform
 terraform_remote_state_stg | terraform
(4 rows)

?? terraform/envs/dev/
?? terraform/envs/stg/
```

dev・stgとも、イメージ、ネットワーク、鍵、コンテナ1台の作成の計画です。`terraform init`の時点で、pgバックエンドに`terraform_remote_state_dev`と`terraform_remote_state_stg`のスキーマが作られ、prodの`terraform_remote_state`とは、スキーマの単位で分かれました。

#### ■ 検証内容：mainに入れてから、dev・stgに適用する

コミットしてプッシュします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git add terraform/envs/dev terraform/envs/stg
git status --short
git commit -m "GitOps第10回: devとstgの環境を追加する"
git push -u origin gitops10-envs-dev-stg
```

**▼ 実行結果**

```plaintext
A  terraform/envs/dev/.terraform.lock.hcl
A  terraform/envs/dev/main.tf
A  terraform/envs/dev/outputs.tf
A  terraform/envs/stg/.terraform.lock.hcl
A  terraform/envs/stg/main.tf
A  terraform/envs/stg/outputs.tf
[gitops10-envs-dev-stg 1c117ec] GitOps第10回: devとstgの環境を追加する
 6 files changed, 204 insertions(+)
（途中省略：作成の一覧、プッシュの表示）
```

このブランチから、プルリクエスト（`#52`）を作成しました。確認の実行は、「GitOps Pipeline」の`#95`です。

**▼ 実行結果（プルリクエスト`#52`の「GitOps Pipeline」の実行`#95`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
terraform/envs/dev/.terraform.lock.hcl
terraform/envs/dev/main.tf
terraform/envs/dev/outputs.tf
terraform/envs/stg/.terraform.lock.hcl
terraform/envs/stg/main.tf
terraform/envs/stg/outputs.tf
base=f69a1aec9be4e3c2a56a72d1a81c8acf1fa9bb23
terraform=true
***=false
```

**▼ 実行結果（「GitOps Pipeline」の実行`#95`、`terraform-plan`ジョブのステップ「Terraform plan」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.
```

`terraform-static`、`terraform-plan`、`ansible-check`が成功し、`ansible-lint`、`molecule`、`record-pending`はスキップされました。パイプラインはprodだけを扱うため、`terraform-plan`はprodの計画で、dev・stgを加えてもprodは`No changes.`のままです。dev・stgの静的なチェックと`plan`は、パイプラインではまだ動いていません。

確認の実行が成功した後に、`#52`をマージしました（マージコミット`dad1c82`）。マージの「GitOps Pipeline」の実行`#96`では、prodの変更なしのplanが、承認待ちとして記録されました。

**▼ 実行結果（`#52`のマージの「GitOps Pipeline」の実行`#96`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示、ファイルの一覧）
0555fc75b7d5b21b96fc39d8e84ca3f6cd7905737b217d90be7ac5a165a25539  tfplan
base=f69a1aec9be4e3c2a56a72d1a81c8acf1fa9bb23
commit=dad1c82a78e461eb7e7c267effde79532ea97fb5
terraform=true
***=false
```

mainを更新し、mainのコードでdev・stgに適用します。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション3と同じく、planを保存してから、保存したplanを適用します。prodの承認待ち（`~/gitops-pending`）には触れません。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline -2
git branch -d gitops10-envs-dev-stg
git push origin --delete gitops10-envs-dev-stg
git status --short; echo "git_status_exit_code=$?"
set -a; . ~/.config/tfstate-backend/backend.env; set +a
mkdir -p -m 700 ~/gitops10-plans
for e in dev stg; do
  echo "== $e"
  cd ~/iac/docker-lab-ci/terraform/envs/$e
  (umask 077; terraform plan -input=false -out="$HOME/gitops10-plans/tfplan-$e" > /dev/null); echo "plan_exit_code=$?"
  terraform apply -input=false "$HOME/gitops10-plans/tfplan-$e" 2>&1 | grep -E 'Creation complete|Apply complete'
done
cd ~/iac/docker-lab-ci
rm -rf ~/gitops10-plans
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
docker network ls
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えと、オブジェクトの受信の表示）
dad1c82 (HEAD -> main, origin/main) Merge pull request #52 from juehara-crypto/gitops10-envs-dev-stg
1c117ec (origin/gitops10-envs-dev-stg, gitops10-envs-dev-stg) GitOps第10回: devとstgの環境を追加する
（途中省略：ブランチの削除の表示）
git_status_exit_code=0
== dev
plan_exit_code=0
module.lab_env.tls_private_key.generated: Creation complete after 0s [id=6274d72b286ecd9815f5f12ffe9c491b839168ec]
module.lab_env.docker_network.this: Creation complete after 2s [id=abf156d2c20a16bb574e93bcd07111a59ce7df2791d412f781d25e7051e393d6]
module.lab_env.docker_image.this: Creation complete after 1m45s [id=sha256:339abaa620aa3e4201f09af17e7a4e6a7a1dda3a968069d907adedaf92ca59bcansible-target:ubuntu22.04-dev]
module.lab_env.docker_container.targets["dev-node1"]: Creation complete after 2s [id=719ffa75f0aff3db5ccdec8e64d7c761e7fb12c979402d324a40bc0a34a98f48]
Apply complete! Resources: 4 added, 0 changed, 0 destroyed.
== stg
plan_exit_code=0
module.lab_env.tls_private_key.generated: Creation complete after 0s [id=5d991c3263b275b531eebd7f8853ba2abe1c84e6]
module.lab_env.docker_network.this: Creation complete after 3s [id=b4f1fdc7ae4bb894c5935cde6eb66b6a012fb992e90dea70230f43cd3182fa49]
module.lab_env.docker_image.this: Creation complete after 4s [id=sha256:339abaa620aa3e4201f09af17e7a4e6a7a1dda3a968069d907adedaf92ca59bcansible-target:ubuntu22.04-stg]
module.lab_env.docker_container.targets["stg-node1"]: Creation complete after 2s [id=68f3476c70e311faf0bf988d44ec240d993e9d78cb16980dfbd4b0c7c485f87e]
Apply complete! Resources: 4 added, 0 changed, 0 destroyed.
NAMES          STATUS         IMAGE
stg-node1      Up 1 second    339abaa620aa
dev-node1      Up 8 seconds   339abaa620aa
target-node1   Up 5 hours     35887767a57b
target-node3   Up 5 hours     35887767a57b
target-node2   Up 5 hours     35887767a57b
tfstate-pg     Up 5 hours     postgres:17
NETWORK ID     NAME              DRIVER    SCOPE
241cceaae174   ansible-app-net   bridge    local
abf156d2c20a   ansible-dev-net   bridge    local
3ab348052bbc   ansible-lab-net   bridge    local
b4f1fdc7ae4b   ansible-stg-net   bridge    local
3c5841844634   bridge            bridge    local
47e376dfb913   host              host      local
00a7783fe2d3   none              null      local
```

最後に、マージで作られたprodの承認待ちを、「GitOps Apply」を、ブランチ「main」、2つの入力を外したまま起動して片付けました（実行`#23`）。`dad1c82`はプルリクエスト`#52`のマージと判定され、`terraform-static`は`success`でした。`ansible`の判定が`false`のため、ansible-lintとMoleculeの結果の確認はスキップされています。

**▼ 実行結果（「GitOps Apply」の実行`#23`、`verify`ジョブのステップ「Check plan policy」と、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）**

```plaintext
（ステップ「Check plan policy」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
0555fc75b7d5b21b96fc39d8e84ca3f6cd7905737b217d90be7ac5a165a25539  /home/control/gitops-pending/tfplan
policy: pass
（ステップ「Terraform apply (saved plan)」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
0555fc75b7d5b21b96fc39d8e84ca3f6cd7905737b217d90be7ac5a165a25539  /home/control/gitops-pending/tfplan

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.
（途中省略：Outputsの表示）
```

`ansible-apply`は、`terraform/`の変更として動き、3台とも`changed=0`でした。

#### ■ 結果

mainの`dad1c82`のコードで、dev・stgの環境ができました。prodの承認待ちは、変更なしのplanとして承認ゲートを通り、片付いています。

1つ、想定していなかった結果がありました。dev・stgのコンテナのイメージは同じID（`339abaa620aa`）ですが、prodのイメージ（`35887767a57b`）とは別のIDです。3つの環境は、同じ`Dockerfile`からイメージを作っています。prodのイメージはより前の時点にビルドしたもので、`Dockerfile`の中の`apt-get update`で入るパッケージが、ビルドした時点によって変わるためと考えられます。devのビルドは1分45秒かかり、stgは4秒でした。stgは、直前にビルドしたdevのビルドキャッシュを使ったと考えられます。

「同じコードを、環境ごとに適用する」構成でも、イメージのように、作った時点で中身が決まるものは、環境ごとに違いうるということです。ビルドしたイメージそのものを環境の間で受け渡す設計は、この回の範囲を超えるため、扱いません。

### 環境ごとに分かれていることを確かめる

3つの環境のtfstateと、コンテナのつながり方を並べて確かめます。

#### ■ 検証内容：環境ごとのtfstateと、コンテナのネットワーク

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
ls -la ~/gitops-pending; echo "exit_code=$?"
for e in dev stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e state list; done
docker exec tfstate-pg psql -U terraform -d terraform_backend -c "SELECT 'prod' AS env, name, length(data) FROM terraform_remote_state.states UNION ALL SELECT 'dev', name, length(data) FROM terraform_remote_state_dev.states UNION ALL SELECT 'stg', name, length(data) FROM terraform_remote_state_stg.states;"
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do docker inspect -f '{{.Name}} id={{printf "%.12s" .Id}} image={{printf "%.19s" .Image}} {{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}' "$n"; done
```

**▼ 実行結果**

```plaintext
ls: cannot access '/home/control/gitops-pending': No such file or directory
exit_code=2
== dev
module.lab_env.docker_container.targets["dev-node1"]
module.lab_env.docker_image.this
module.lab_env.docker_network.this
module.lab_env.tls_private_key.generated
== stg
module.lab_env.docker_container.targets["stg-node1"]
module.lab_env.docker_image.this
module.lab_env.docker_network.this
module.lab_env.tls_private_key.generated
== prod
docker_image.ansible_target_deploy_nopasswd
docker_image.ansible_target_deploy_passwd
docker_image.ansible_target_legacy
docker_network.app_net
module.lab_env.docker_container.targets["target-node1"]
module.lab_env.docker_container.targets["target-node2"]
module.lab_env.docker_container.targets["target-node3"]
module.lab_env.docker_image.this
module.lab_env.docker_network.this
module.lab_env.tls_private_key.generated
 env  |  name   | length
------+---------+--------
 prod | default |  29018
 dev  | default |  11587
 stg  | default |  11587
(3 rows)

/dev-node1 id=719ffa75f0af image=sha256:339abaa620aa ansible-dev-net=172.20.0.2
/stg-node1 id=68f3476c70e3 image=sha256:339abaa620aa ansible-stg-net=172.21.0.2
/target-node1 id=2ae67f98c381 image=sha256:35887767a57b ansible-lab-net=172.19.0.2
/target-node2 id=48305fbf396c image=sha256:35887767a57b ansible-lab-net=172.19.0.3
/target-node3 id=6e6e1fc26bdd image=sha256:35887767a57b ansible-lab-net=172.19.0.4
```

#### ■ 結果

dev・stgの記録は、それぞれ自分の環境のコンテナ、イメージ、ネットワーク、鍵の4つだけで、ほかの環境のリソースは含まれていません。pgバックエンドでは、3つのスキーマに、それぞれ`default`の行が1つずつあります。ワークスペースのように同じテーブルの別の行ではなく、スキーマの単位で分かれた、別々の記録です。

各コンテナは、自分の環境のネットワーク1つだけにつながっています。dev・stgのネットワークのサブネットは指定せず、Dockerが既存の範囲（172.17〜172.19）とぶつからないように、172.20と172.21を割り当てました。鍵も、環境ごとに別々に作られています。

### ある環境への変更は、その環境の中にとどまる

devの値だけを変えて、devに適用します。そのうえで、stg・prodの`plan`が変わらないことを確かめます。コミットしない一時的な変更で、最後に元に戻します。

#### ■ 検証内容：devにコンテナを1台加えて適用する

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
sed -i 's|    "dev-node1" = 2241|    "dev-node1" = 2241\n    "dev-node2" = 2242|' terraform/envs/dev/main.tf
git --no-pager diff
mkdir -p -m 700 ~/gitops10-plans
cd terraform/envs/dev
(umask 077; terraform plan -input=false -out="$HOME/gitops10-plans/tfplan-dev-add" > /dev/null); echo "plan_exit_code=$?"
terraform show -no-color "$HOME/gitops10-plans/tfplan-dev-add" | grep -E '^  # |^Plan:'
terraform apply -input=false "$HOME/gitops10-plans/tfplan-dev-add" 2>&1 | grep -E 'Creation complete|Apply complete'
terraform state list
cd ~/iac/docker-lab-ci
for e in stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e plan -input=false -detailed-exitcode > /dev/null 2>&1; echo "plan_exit_code=$?"; done
docker ps --format '{{.Names}}' | sort
```

**▼ 実行結果**

```plaintext
diff --git a/terraform/envs/dev/main.tf b/terraform/envs/dev/main.tf
index 9375ae5..f8b9d32 100644
--- a/terraform/envs/dev/main.tf
+++ b/terraform/envs/dev/main.tf
@@ -28,6 +28,7 @@ module "lab_env" {

   nodes = {
     "dev-node1" = 2241
+    "dev-node2" = 2242
   }

   network_name          = "ansible-dev-net"
plan_exit_code=0
  # module.lab_env.docker_container.targets["dev-node2"] will be created
Plan: 1 to add, 0 to change, 0 to destroy.
module.lab_env.docker_container.targets["dev-node2"]: Creation complete after 2s [id=f02db22821cf31fc9bfb15c27c5b1915bca1acb4a2364651c50e2bdd8be8fb9b]
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
module.lab_env.docker_container.targets["dev-node1"]
module.lab_env.docker_container.targets["dev-node2"]
module.lab_env.docker_image.this
module.lab_env.docker_network.this
module.lab_env.tls_private_key.generated
== stg
plan_exit_code=0
== prod
plan_exit_code=0
dev-node1
dev-node2
stg-node1
target-node1
target-node2
target-node3
tfstate-pg
```

devを元に戻します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
git restore terraform/envs/dev/main.tf
cd terraform/envs/dev
(umask 077; terraform plan -input=false -out="$HOME/gitops10-plans/tfplan-dev-revert" > /dev/null); echo "plan_exit_code=$?"
terraform show -no-color "$HOME/gitops10-plans/tfplan-dev-revert" | grep -E '^  # |^Plan:'
terraform apply -input=false "$HOME/gitops10-plans/tfplan-dev-revert" 2>&1 | grep -E 'Destruction complete|Apply complete'
terraform state list
cd ~/iac/docker-lab-ci
rm -rf ~/gitops10-plans
git status --short; echo "git_status_exit_code=$?"
docker ps --format '{{.Names}}' | sort
```

**▼ 実行結果**

```plaintext
plan_exit_code=0
  # module.lab_env.docker_container.targets["dev-node2"] will be destroyed
  # (because key ["dev-node2"] is not in for_each map)
Plan: 0 to add, 0 to change, 1 to destroy.
module.lab_env.docker_container.targets["dev-node2"]: Destruction complete after 1s
Apply complete! Resources: 0 added, 0 changed, 1 destroyed.
module.lab_env.docker_container.targets["dev-node1"]
module.lab_env.docker_image.this
module.lab_env.docker_network.this
module.lab_env.tls_private_key.generated
git_status_exit_code=0
dev-node1
stg-node1
target-node1
target-node2
target-node3
tfstate-pg
```

#### ■ 結果

devに`dev-node2`を加えて適用しても、stg・prodの`plan`は差分なし（`plan_exit_code=0`）のままでした。元に戻す変更も、devの`dev-node2`の削除だけで、devは元の4つのリソースに戻っています。環境ごとのディレクトリに書いた値の変更は、その環境のtfstateと、その環境のリソースにしか届きません。

### 共通のコードの変更は、すべての環境に届く

逆に、共通のモジュールを変えたときは、どうなるかを確かめます。コンテナに置くファイル（`/etc/init_marker`）の中身を、モジュールの中で`v1`から`v2`に変え、3つの環境の`plan`を並べます。適用はしません。

#### ■ 検証内容：共通のモジュールを変えたときの、3つの環境のplan

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
sed -i 's|init_version=v1|init_version=v2|' terraform/modules/lab_env/main.tf
git --no-pager diff
for e in dev stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e plan -input=false -no-color | grep -E '^  # |forces replacement|^Plan:'; done
git restore terraform/modules/lab_env/main.tf
git status --short; echo "git_status_exit_code=$?"
```

**▼ 実行結果**

```plaintext
diff --git a/terraform/modules/lab_env/main.tf b/terraform/modules/lab_env/main.tf
index 57961b9..eb89b05 100644
--- a/terraform/modules/lab_env/main.tf
+++ b/terraform/modules/lab_env/main.tf
@@ -52,7 +52,7 @@ resource "docker_container" "targets" {
   }
   upload {
     file    = "/etc/init_marker"
-    content = "init_version=v1\n"
+    content = "init_version=v2\n"
   }
   lifecycle {
     ignore_changes = [network_mode]
== dev
  # module.lab_env.docker_container.targets["dev-node1"] must be replaced
      - upload { # forces replacement
      + upload { # forces replacement
Plan: 1 to add, 0 to change, 1 to destroy.
== stg
  # module.lab_env.docker_container.targets["stg-node1"] must be replaced
      - upload { # forces replacement
      + upload { # forces replacement
Plan: 1 to add, 0 to change, 1 to destroy.
== prod
  # module.lab_env.docker_container.targets["target-node1"] must be replaced
      - upload { # forces replacement
      + upload { # forces replacement
  # module.lab_env.docker_container.targets["target-node2"] must be replaced
      - upload { # forces replacement
      + upload { # forces replacement
  # module.lab_env.docker_container.targets["target-node3"] must be replaced
      - upload { # forces replacement
      + upload { # forces replacement
Plan: 3 to add, 0 to change, 3 to destroy.
git_status_exit_code=0
```

#### ■ 結果

モジュールの中の1行の変更が、3つの環境すべての`plan`に、コンテナの作り直しとして現れました（devとstgは1台、prodは3台）。`upload`の中身の変更は、コンテナの作り直しになります。

Ansible×Terraformシリーズの **[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)** では、共通部分への変更が、それを参照するすべての呼び出し元に一括で及ぶことを確認しました。同じ構造が、ここでは環境の単位で現れています。mainの1本と環境ごとのディレクトリで分ける構成では、共通のコードの変更は、mainに入った時点で、すべての環境の「これから適用するもの」になります。それを、devで試してからstg、stgで試してからprodと、順に届けるのが、**[セクション5](#5-昇格の順序と条件をワークフローで強制する)** の昇格の順序と条件です。

### 終了時点の状態

移す前の`terraform/`の直下に残っていた、初期化の作業用のディレクトリ（`.terraform/`）とパスワードの変数ファイル（`terraform.tfvars`）は、どの環境からも使われなくなったため削除しました。パスワードを含むファイルの複製を減らすためです。各環境のディレクトリには、それぞれの変数ファイルがあります。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
rm -rf terraform/.terraform
rm terraform/terraform.tfvars
ls -la terraform/
git status --short; echo "git_status_exit_code=$?"
git log --oneline -1
ls -la ~/gitops-pending; echo "exit_code=$?"
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for e in dev stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e plan -input=false -detailed-exitcode > /dev/null 2>&1; echo "plan_exit_code=$?"; done
cd ansible
ansible-playbook -i dynamic_inventory.py site.yml --check 2>/dev/null | tail -4
```

**▼ 実行結果**

```plaintext
total 36
drwxrwxr-x 4 control control 4096 Oct 11 05:19 .
drwxrwxr-x 7 control control 4096 Oct 11 00:21 ..
-rw-rw-r-- 1 control control  778 Oct  5 07:19 Dockerfile
-rw-rw-r-- 1 control control  567 Oct  5 07:19 Dockerfile.deploy_nopasswd
-rw-rw-r-- 1 control control  567 Oct  5 07:19 Dockerfile.deploy_passwd
-rw-rw-r-- 1 control control  769 Oct  5 07:19 Dockerfile.legacy
drwxrwxr-x 5 control control 4096 Oct 11 03:13 envs
-rw-rw-r-- 1 control control  107 Oct  5 07:19 id_ed25519.pub
drwxrwxr-x 3 control control 4096 Oct 11 00:55 modules
git_status_exit_code=0
dad1c82 (HEAD -> main, origin/main) Merge pull request #52 from juehara-crypto/gitops10-envs-dev-stg
ls: cannot access '/home/control/gitops-pending': No such file or directory
exit_code=2
== dev
plan_exit_code=0
== stg
plan_exit_code=0
== prod
plan_exit_code=0
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

#### ■ 結果

mainは`dad1c82`、承認待ちはなく、3つの環境とも`terraform plan`は差分なしです。prodの確認モードは、3台とも`changed=0`でした。

このセクションで確認したことを並べると、次のとおりです。

* ワークスペースでは、どの環境を操作するかが、Gitの外の手元のファイルで決まり、初期化し直すと、指定を忘れたまま`default`の環境を操作した
* 環境ごとのディレクトリに、その環境のスキーマと値を書く構成にし、pgバックエンドのtfstateをスキーマの単位で分けた
* イメージの`context`は、指す場所が同じでも、文字列が変わるだけで作り直しになり、参照するコンテナまで作り直しの計画になった。`ignore_changes = [build]`で、作り直しの判定から外した
* 既存の環境は、`moved`ブロックでモジュールの中に付け替え、コンテナを1台も作り直さずに、承認ゲートを通してprodとして移した
* dev・stgは、mainのコードで手元から作った。同じ`Dockerfile`からでも、ビルドした時点によって、イメージの中身は環境ごとに違った
* 環境ごとの値の変更は、その環境の中にとどまり、共通のモジュールの変更は、すべての環境の`plan`に現れた

ただし、この時点では、tfstateが環境ごとに分かれただけです。Ansibleのインベントリを作る`dynamic_inventory.py`は、prodのtfstateだけを読む形のままで、dev・stgのコンテナには、Ansibleからは届きません。次のセクションでは、環境ごとのtfstateから、環境ごとのインベントリを作ります。

---

[↑ 目次に戻る](#-目次)

---

## 4. インベントリと変数を環境ごとに分ける

環境ごとのtfstateから、環境ごとのインベントリを作り、Ansibleの環境ごとの値を変数で渡します。そのうえで、ある環境に向けた実行が、ほかの環境に届かないことを確かめます。

### インベントリを、環境ごとのディレクトリで選ぶ

**[セクション3](#3-tfstateを環境ごとに分ける)** の終了時点で、Ansibleのインベントリを作る`dynamic_inventory.py`は、`terraform/envs/prod`のtfstateだけを読む形でした。どの環境のインベントリを使うかを指定できるようにする方法は、主に2つあります。

|方法|指定のしかた|指定を誤ったとき・忘れたとき|
|---|---|---|
|環境変数|`GITOPS_ENV=dev ansible-playbook -i dynamic_inventory.py ...`|変数の値を誤れば、別の環境を操作する。忘れたときの扱いは、スクリプトの作り方しだい|
|環境ごとのディレクトリ|`ansible-playbook -i inventories/dev ...`|指定がパスとしてコマンドとログに残る。存在しない環境は指定できない|

環境変数は、**[セクション3](#3-tfstateを環境ごとに分ける)** で確かめたワークスペースと同じく、どの環境を操作するかを、コードの外の状態で決める方法です。本シリーズは、Terraformと同じく、環境ごとのディレクトリで選ぶ形にします。

* インベントリのスクリプトの本体は、`ansible/inventories/terraform_inventory.py`の1つだけにする
* `ansible/inventories/dev`・`stg`・`prod`の各ディレクトリには、本体へのシンボリックリンクを置く
* スクリプトは、自分が置かれたディレクトリの名前で、読む`terraform/envs/<環境>`と、使う鍵（`ansible/keys/<環境>/id_ed25519_generated`）を決める
* 環境の名前として知らないディレクトリから実行された場合は、エラーで終わる。既定でprodを読むような動きはさせない

鍵の置き場所を`inventories/<環境>/`の中にしなかったのは、`-i inventories/dev`のようにディレクトリをインベントリとして渡すと、Ansibleがそのディレクトリの中のファイルを、インベントリとして読もうとするためです。

#### ■ 検証内容：インベントリのスクリプトを、環境ごとのディレクトリに分ける

作業用のブランチを作り、`dynamic_inventory.py`をスクリプトの本体の場所に移して書き換え、各環境のディレクトリにシンボリックリンクを置きます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops10-inventories
mkdir -p ansible/inventories/dev ansible/inventories/stg ansible/inventories/prod
git mv ansible/dynamic_inventory.py ansible/inventories/terraform_inventory.py
cat > ansible/inventories/terraform_inventory.py <<'EOF'
（ファイルの内容。下のcat -nの結果と同じ）
EOF
chmod +x ansible/inventories/terraform_inventory.py
for e in dev stg prod; do ln -s ../terraform_inventory.py ansible/inventories/$e/terraform_inventory.py; done
ls -la ansible/inventories ansible/inventories/dev ansible/inventories/stg ansible/inventories/prod
cat -n ansible/inventories/terraform_inventory.py
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops10-inventories'
ansible/inventories:
total 24
drwxrwxr-x 5 control control 4096 Oct 11 05:38 .
drwxrwxr-x 5 control control 4096 Oct 11 05:38 ..
drwxrwxr-x 2 control control 4096 Oct 11 05:38 dev
drwxrwxr-x 2 control control 4096 Oct 11 05:38 prod
drwxrwxr-x 2 control control 4096 Oct 11 05:38 stg
-rwxrwxr-x 1 control control 1486 Oct 11 05:38 terraform_inventory.py

ansible/inventories/dev:
total 8
drwxrwxr-x 2 control control 4096 Oct 11 05:38 .
drwxrwxr-x 5 control control 4096 Oct 11 05:38 ..
lrwxrwxrwx 1 control control   25 Oct 11 05:38 terraform_inventory.py -> ../terraform_inventory.py

ansible/inventories/prod:
total 8
drwxrwxr-x 2 control control 4096 Oct 11 05:38 .
drwxrwxr-x 5 control control 4096 Oct 11 05:38 ..
lrwxrwxrwx 1 control control   25 Oct 11 05:38 terraform_inventory.py -> ../terraform_inventory.py

ansible/inventories/stg:
total 8
drwxrwxr-x 2 control control 4096 Oct 11 05:38 .
drwxrwxr-x 5 control control 4096 Oct 11 05:38 ..
lrwxrwxrwx 1 control control   25 Oct 11 05:38 terraform_inventory.py -> ../terraform_inventory.py
     1  #!/usr/bin/env python3
     2  # terraform outputから、Ansibleの動的インベントリを作る。
     3  # このファイルは、inventories/<環境>/の下にシンボリックリンクとして置く。
     4  # 置かれたディレクトリの名前で、読むterraform/envs/<環境>と、使う鍵を決める。
     5  import json
     6  import os
     7  import subprocess
     8  import sys
     9
    10  ENVS = ("dev", "stg", "prod")
    11
    12  inventory_dir = os.path.dirname(os.path.abspath(__file__))
    13  env = os.path.basename(inventory_dir)
    14  if env not in ENVS:
    15      sys.stderr.write("unknown environment: %s (use inventories/<env>/)\n" % env)
    16      sys.exit(1)
    17
    18  ansible_dir = os.path.join(inventory_dir, "..", "..")
    19  result = subprocess.run(
    20      ["terraform", "output", "-json", "target_nodes"],
    21      capture_output=True, text=True,
    22      cwd=os.path.join(ansible_dir, "..", "terraform", "envs", env)
    23  )
    24  if result.returncode != 0:
    25      sys.stderr.write(result.stderr)
    26      sys.exit(result.returncode)
    27  nodes = json.loads(result.stdout)
    28  key_file = os.path.normpath(os.path.join(ansible_dir, "keys", env, "id_ed25519_generated"))
    29  inventory = {
    30      "target_nodes": {
    31          "hosts": list(nodes.keys())
    32      },
    33      "_meta": {
    34          "hostvars": {
    35              name: {
    36                  "ansible_host": v["host"],
    37                  "ansible_port": v["port"],
    38                  "ansible_user": "ansible",
    39                  "ansible_ssh_private_key_file": key_file
    40              }
    41              for name, v in nodes.items()
    42          }
    43      }
    44  }
    45  print(json.dumps(inventory))
```

12〜13行目で、スクリプトが置かれたディレクトリの名前を環境の名前として取り出します。`os.path.abspath`はシンボリックリンクをたどらないため、`inventories/dev/terraform_inventory.py`として実行されれば、環境の名前は`dev`になります。22行目でその環境の`terraform/envs/<環境>`から`terraform output`を読み、28行目と39行目で、その環境の鍵のパスを各ホストに渡します。それ以外は、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** の`dynamic_inventory.py`と同じです。

3つの環境のインベントリを確かめます。最後の2行は、スクリプトの本体を直接実行した場合、つまり、環境の名前として知らないディレクトリから実行された場合の確認です。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for e in dev stg prod; do echo "== $e"; ansible-inventory -i inventories/$e --graph; done
ansible-inventory -i inventories/dev --host dev-node1
./inventories/terraform_inventory.py; echo "exit_code=$?"
ansible-inventory -i inventories/terraform_inventory.py --graph; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
== dev
@all:
  |--@ungrouped:
  |--@target_nodes:
  |  |--dev-node1
== stg
@all:
  |--@ungrouped:
  |--@target_nodes:
  |  |--stg-node1
== prod
@all:
  |--@ungrouped:
  |--@target_nodes:
  |  |--target-node1
  |  |--target-node2
  |  |--target-node3
{
    "ansible_host": "172.20.0.2",
    "ansible_port": 22,
    "ansible_ssh_private_key_file": "/home/control/iac/docker-lab-ci/ansible/keys/dev/id_ed25519_generated",
    "ansible_user": "ansible"
}
unknown environment: inventories (use inventories/<env>/)
exit_code=1
[WARNING]:  * Failed to parse /home/control/iac/docker-lab-ci/ansible/inventories/terraform_inventory.py with script plugin: Inventory script (/home/control/iac/docker-lab-
ci/ansible/inventories/terraform_inventory.py) had an execution error: unknown environment: inventories (use inventories/<env>/)
[WARNING]:  * Failed to parse /home/control/iac/docker-lab-ci/ansible/inventories/terraform_inventory.py with ini plugin: /home/control/iac/docker-lab-
ci/ansible/inventories/terraform_inventory.py:5: Expected key=value host variable assignment, got: json
[WARNING]: Unable to parse /home/control/iac/docker-lab-ci/ansible/inventories/terraform_inventory.py as an inventory source
ERROR! No inventory was parsed, please check your configuration and options.
exit_code=1
```

#### ■ 結果

dev・stg・prodのインベントリには、それぞれ`dev-node1`、`stg-node1`、target-node1〜3だけが入りました。グループの名前は、どの環境も`target_nodes`のままなので、`site.yml`の`hosts: target_nodes`は変えずに使えます。

スクリプトの本体を直接実行した場合は、`unknown environment: inventories`で終わりました。Ansibleからも、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で設定した`unparsed_is_failed = True`によって、「No inventory was parsed」で失敗しています。環境を指定しないまま、どこかの環境を読んでしまうことはありません。

### 鍵も、環境ごとに分ける

**[セクション3](#3-tfstateを環境ごとに分ける)** で、Ansibleの接続に使う鍵（`tls_private_key`）は、環境ごとに別々に作られました。各環境のtfstateから、その環境の鍵を書き出します。

#### ■ 検証内容：環境ごとの鍵で、それぞれの環境に接続する

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for e in dev stg prod; do
  mkdir -p -m 700 keys/$e
  (umask 077; terraform -chdir=../terraform/envs/$e output -raw generated_private_key > keys/$e/id_ed25519_generated)
done
ls -la keys keys/dev keys/stg keys/prod
cd ~/iac/docker-lab-ci
git status --short
cd ansible
for e in dev stg prod; do echo "== $e"; ansible all -i inventories/$e -m ansible.builtin.ping -o 2>/dev/null; done
```

**▼ 実行結果**

```plaintext
keys:
total 20
drwxrwxr-x 5 control control 4096 Oct 11 05:39 .
drwxrwxr-x 6 control control 4096 Oct 11 05:39 ..
drwx------ 2 control control 4096 Oct 11 05:39 dev
drwx------ 2 control control 4096 Oct 11 05:39 prod
drwx------ 2 control control 4096 Oct 11 05:39 stg

keys/dev:
total 12
drwx------ 2 control control 4096 Oct 11 05:39 .
drwxrwxr-x 5 control control 4096 Oct 11 05:39 ..
-rw------- 1 control control  387 Oct 11 05:39 id_ed25519_generated

keys/prod:
total 12
drwx------ 2 control control 4096 Oct 11 05:39 .
drwxrwxr-x 5 control control 4096 Oct 11 05:39 ..
-rw------- 1 control control  387 Oct 11 05:39 id_ed25519_generated

keys/stg:
total 12
drwx------ 2 control control 4096 Oct 11 05:39 .
drwxrwxr-x 5 control control 4096 Oct 11 05:39 ..
-rw------- 1 control control  387 Oct 11 05:39 id_ed25519_generated
RM ansible/dynamic_inventory.py -> ansible/inventories/terraform_inventory.py
?? ansible/inventories/dev/
?? ansible/inventories/prod/
?? ansible/inventories/stg/
（途中省略：Pythonのインタープリターに関する警告）
== dev
dev-node1 | SUCCESS => {"ansible_facts": {"discovered_interpreter_python": "/usr/bin/python3.10"},"changed": false,"ping": "pong",（以下省略）}
== stg
stg-node1 | SUCCESS => {"ansible_facts": {"discovered_interpreter_python": "/usr/bin/python3.10"},"changed": false,"ping": "pong",（以下省略）}
== prod
target-node3 | SUCCESS => {"ansible_facts": {"discovered_interpreter_python": "/usr/bin/python3.10"},"changed": false,"ping": "pong",（以下省略）}
target-node1 | SUCCESS => {"ansible_facts": {"discovered_interpreter_python": "/usr/bin/python3.10"},"changed": false,"ping": "pong",（以下省略）}
target-node2 | SUCCESS => {"ansible_facts": {"discovered_interpreter_python": "/usr/bin/python3.10"},"changed": false,"ping": "pong",（以下省略）}
```

鍵は`-rw-------`で書き出され、`git status`には現れていません。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で`.gitignore`に加えた`id_ed25519_generated`は、どのディレクトリの同じ名前のファイルにも効くためです。それぞれの環境の鍵で、3つの環境すべてに接続できました。

#### ■ 検証内容：devの鍵で、prodのコンテナに接続を試みる

devの鍵で、prodのtarget-node1に接続できないことを確かめます。

最初にこの確認をしたとき、devの鍵を指定したAnsibleの接続は、prodのtarget-node1に成功してしまいました。その原因を調べた結果を示します。まず、target-node1の`authorized_keys`に入っている鍵と、各鍵のフィンガープリントを並べ、`ssh`を直接実行して、devの鍵だけで接続を試みます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
ssh-keygen -lf keys/dev/id_ed25519_generated
ssh-keygen -lf keys/prod/id_ed25519_generated
ssh-keygen -lf ../terraform/id_ed25519.pub
docker exec target-node1 sh -c 'ssh-keygen -lf /home/ansible/.ssh/authorized_keys'
ssh -v -o BatchMode=yes -o StrictHostKeyChecking=no -i keys/dev/id_ed25519_generated ansible@172.19.0.2 true 2>&1 | grep -E 'Offering public key|Server accepts key|Authenticated to|Permission denied'; echo "exit_code=${PIPESTATUS[0]}"
```

**▼ 実行結果**

```plaintext
256 SHA256:87k/k3EyzFKJxLeqM/s4/9DGamKVfI47ObDuy71yEiQ  (ED25519)
256 SHA256:GMbi9fSgLhSJ025ImKtSUYbiWImIKFpcdV7+KqEktiQ  (ED25519)
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
256 SHA256:GMbi9fSgLhSJ025ImKtSUYbiWImIKFpcdV7+KqEktiQ  (ED25519)
debug1: Offering public key: keys/dev/id_ed25519_generated ED25519 SHA256:87k/k3EyzFKJxLeqM/s4/9DGamKVfI47ObDuy71yEiQ explicit
ansible@172.19.0.2: Permission denied (publickey,password).
exit_code=255
```

target-node1の`authorized_keys`には、prodの鍵（`GMbi...`）と、`terraform/id_ed25519.pub`の鍵（`Apv1...`）の2つが入っていて、devの鍵（`87k/...`）は入っていません。`ssh`を直接実行すると、devの鍵だけを提示して拒否されました（`Permission denied`）。`ssh`の単体では、devの鍵ではprodに入れていません。

最初の確認で成功したのは、Ansibleが既定で使う、SSHの接続の再利用（`ControlPersist`）のためでした。Ansibleは、接続を一定の時間保持し、同じ接続先への次の実行で使い回します。それを再現します。prodの鍵で接続した直後に、devの鍵を指定して同じホストに接続し、65秒待ってからもう一度接続します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
ansible target-node1 -i inventories/prod -m ansible.builtin.ping -o 2>/dev/null; echo "exit_code=$?"
ls -la ~/.ansible/cp/
ansible target-node1 -i inventories/prod -m ansible.builtin.ping -o -e "ansible_ssh_private_key_file=$PWD/keys/dev/id_ed25519_generated" 2>/dev/null; echo "exit_code=$?"
sleep 65
ls -la ~/.ansible/cp/
ansible target-node1 -i inventories/prod -m ansible.builtin.ping -o -e "ansible_ssh_private_key_file=$PWD/keys/dev/id_ed25519_generated" 2>/dev/null; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
target-node1 | SUCCESS => {"ansible_facts": {"discovered_interpreter_python": "/usr/bin/python3.10"},"changed": false,"ping": "pong",（以下省略）}
exit_code=0
total 8
drwx------ 2 control control 4096 Oct 11 05:50 .
drwxrwxr-x 7 control control 4096 Aug 27 05:06 ..
srw------- 1 control control    0 Oct 11 05:50 f860859377
target-node1 | SUCCESS => {"ansible_facts": {"discovered_interpreter_python": "/usr/bin/python3.10"},"changed": false,"ping": "pong",（以下省略）}
exit_code=0
total 8
drwx------ 2 control control 4096 Oct 11 05:51 .
drwxrwxr-x 7 control control 4096 Aug 27 05:06 ..
target-node1 | UNREACHABLE!: Failed to connect to the host via ssh: ansible@172.19.0.2: Permission denied (publickey,password).
exit_code=4
```

#### ■ 結果

prodの鍵で接続した直後、`~/.ansible/cp/`に接続のソケットができ、その間はdevの鍵を指定しても、同じソケットを使い回して接続に成功しました。65秒後にソケットが消えると、devの鍵での接続は`Permission denied`で`UNREACHABLE`になりました。

鍵は環境ごとに分かれていて、devの鍵ではprodのコンテナに入れません。ただし、Ansibleは既定で接続を再利用するため、鍵が環境を分けていることを確かめるときは、再利用を止めるか、保持の時間が過ぎてから確かめる必要があります。再利用のソケットは、接続先のホスト、ポート、ユーザーごとに作られるため、ある環境のインベントリから、別の環境のホストに接続することはありません。環境の分け方そのものを崩すものではありません。

一方で、`authorized_keys`には、`terraform/id_ed25519.pub`の鍵が、すべての環境に入っています。これは、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** より前から、操作する人が手元から接続するために入れている鍵です。Ansibleは、インベントリが渡す鍵を明示して接続するため、この鍵は使いません。ただし、この鍵の秘密鍵を持つ人は、どの環境にも入れます。どの鍵を、どこに置き、誰に持たせるかは、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

### 環境ごとの値を、同じロールに渡す

環境ごとに違う値は、**[セクション2](#2-ブランチで分けるかディレクトリで分けるか)** で整理したとおり、同じコードに渡す値の違いとして表します。Ansibleでは、環境ごとのインベントリのディレクトリに置いた`group_vars`で渡します。

今のPlaybookには、環境によって値が変わる変数がありません。例として、ロール`common_setup`に、環境の名前を書いたファイル（`/etc/gitops-env.conf`）を置くタスクを加えます。値は、各環境の`inventories/<環境>/group_vars/target_nodes.yml`で渡し、ロールの既定値（`defaults/main.yml`）には`unknown`を置きます。**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** で組み込んだMoleculeのテストは、環境のインベントリを使わずにロールだけを試すため、既定値がないと失敗するためです。変数名は、同じ回で確認したansible-lintのルール（ロールの変数には、ロール名の接頭辞を付ける）に合わせて、`common_setup_env`にしました。

#### ■ 検証内容：環境ごとの値を渡し、ansible-lintとMoleculeを通す

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
mkdir -p roles/common_setup/defaults
cat > roles/common_setup/defaults/main.yml <<'EOF'
（ファイルの内容。下のcat -nの結果と同じ）
EOF
cat > roles/common_setup/tasks/environment.yml <<'EOF'
（ファイルの内容。下のcat -nの結果と同じ）
EOF
cat >> roles/common_setup/tasks/main.yml <<'EOF'
- name: 環境の名前のタスクを読み込み
  ansible.builtin.import_tasks: environment.yml
EOF
for e in dev stg prod; do
  mkdir -p inventories/$e/group_vars
  printf -- '---\ncommon_setup_env: %s\n' "$e" > inventories/$e/group_vars/target_nodes.yml
done
cat -n roles/common_setup/defaults/main.yml
cat -n roles/common_setup/tasks/environment.yml
cat -n roles/common_setup/tasks/main.yml
for e in dev stg prod; do echo "== $e"; cat -n inventories/$e/group_vars/target_nodes.yml; done
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for n in dev:dev-node1 stg:stg-node1 prod:target-node1; do ansible-inventory -i inventories/${n%%:*} --host ${n#*:} | grep -E 'common_setup_env|ansible_host'; done
ANSIBLE_INVENTORY_UNPARSED_FAILED=False ansible-lint --nocolor 2>&1 | tail -3; echo "lint_exit_code=${PIPESTATUS[0]}"
cd roles/common_setup
molecule test > /tmp/gitops10-molecule.log 2>&1; echo "molecule_exit_code=$?"
grep -E 'Executed: Successful|Executed: Failed|failed=' /tmp/gitops10-molecule.log | tail -6
rm /tmp/gitops10-molecule.log
```

**▼ 実行結果**

```plaintext
     1  ---
     2  common_setup_env: unknown
     1  ---
     2  - name: 環境の名前を書いたファイルを配置
     3    become: true
     4    ansible.builtin.copy:
     5      dest: /etc/gitops-env.conf
     6      content: "env={{ common_setup_env }}\n"
     7      mode: "0644"
     1  ---
     2  - name: ドリフト検知のタスクを読み込み
     3    ansible.builtin.import_tasks: drift_check.yml
     4  - name: 環境の名前のタスクを読み込み
     5    ansible.builtin.import_tasks: environment.yml
== dev
     1  ---
     2  common_setup_env: dev
== stg
     1  ---
     2  common_setup_env: stg
== prod
     1  ---
     2  common_setup_env: prod
    "ansible_host": "172.20.0.2",
    "common_setup_env": "dev"
    "ansible_host": "172.21.0.2",
    "common_setup_env": "stg"
    "ansible_host": "172.19.0.2",
    "common_setup_env": "prod"

Passed: 0 failure(s), 0 warning(s) in 16 files processed of 21 encountered. Last profile that met the validation criteria was 'production'.
（途中省略：新しいバージョンの案内）
lint_exit_code=0
molecule_exit_code=0
default ➜ syntax: Executed: Successful
default ➜ create: Executed: Successful
default ➜ converge: Executed: Successful
default ➜ idempotence: Executed: Successful
default ➜ destroy: Executed: Successful
default                   : actions=12  successful=6  disabled=0  skipped=0  missing=7  failed=0
```

#### ■ 結果

dev・stg・prodのホストに、それぞれ`common_setup_env`として`dev`・`stg`・`prod`が渡りました。ロールのコードは1つで、環境ごとに違うのは、インベントリのディレクトリに置いた値だけです。ansible-lintは通り、Moleculeも、既定値の`unknown`で`converge`・`idempotence`とも成功しています。

### devへの実行は、ほかの環境に届かない

devのインベントリで`ansible-playbook`を実行し、stg・prodのコンテナに変化がないことを確かめます。実行の前後で、5台のコンテナのファイルの状態を記録します。dev-node1とstg-node1は、作ってから一度もAnsibleを実行していないため、`/etc/drift-check-target.conf`もない状態から始まります。

#### ■ 検証内容：devだけにAnsibleを実行する

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n sh -c 'ls -l --time-style=+%H:%M:%S /etc/drift-check-target.conf /etc/gitops-env.conf 2>&1'; done
ansible-playbook -i inventories/dev site.yml --diff 2>/dev/null | grep -vE '^\s*$'
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n sh -c 'ls -l --time-style=+%H:%M:%S /etc/drift-check-target.conf /etc/gitops-env.conf 2>&1; cat /etc/gitops-env.conf 2>/dev/null'; done
```

**▼ 実行結果**

```plaintext
== dev-node1
ls: cannot access '/etc/drift-check-target.conf': No such file or directory
ls: cannot access '/etc/gitops-env.conf': No such file or directory
== stg-node1
ls: cannot access '/etc/drift-check-target.conf': No such file or directory
ls: cannot access '/etc/gitops-env.conf': No such file or directory
== target-node1
ls: cannot access '/etc/gitops-env.conf': No such file or directory
-rw-r--r-- 1 root root 33 08:29:50 /etc/drift-check-target.conf
== target-node2
ls: cannot access '/etc/gitops-env.conf': No such file or directory
-rw-r--r-- 1 root root 33 21:58:56 /etc/drift-check-target.conf
== target-node3
ls: cannot access '/etc/gitops-env.conf': No such file or directory
-rw-r--r-- 1 root root 33 21:58:56 /etc/drift-check-target.conf
PLAY [接続確認用Playbook] ******************************************************
TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
--- before
+++ after: /etc/drift-check-target.conf
@@ -0,0 +1 @@
+monitored_by=ansible-drift-check
changed: [dev-node1]
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before
+++ after: /etc/gitops-env.conf
@@ -0,0 +1 @@
+env=dev
changed: [dev-node1]
TASK [疎通確認] ****************************************************************
ok: [dev-node1]
PLAY RECAP *********************************************************************
dev-node1                  : ok=3    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== dev-node1
-rw-r--r-- 1 root root 33 05:55:51 /etc/drift-check-target.conf
-rw-r--r-- 1 root root  8 05:55:54 /etc/gitops-env.conf
env=dev
== stg-node1
ls: cannot access '/etc/drift-check-target.conf': No such file or directory
ls: cannot access '/etc/gitops-env.conf': No such file or directory
== target-node1
ls: cannot access '/etc/gitops-env.conf': No such file or directory
-rw-r--r-- 1 root root 33 08:29:50 /etc/drift-check-target.conf
== target-node2
ls: cannot access '/etc/gitops-env.conf': No such file or directory
-rw-r--r-- 1 root root 33 21:58:56 /etc/drift-check-target.conf
== target-node3
ls: cannot access '/etc/gitops-env.conf': No such file or directory
-rw-r--r-- 1 root root 33 21:58:56 /etc/drift-check-target.conf
```

#### ■ 結果

`-i inventories/dev`で実行した`ansible-playbook`は、dev-node1だけを対象にし、2つのファイルを置きました（`changed=2`）。`/etc/gitops-env.conf`には、devの`group_vars`の値（`env=dev`）が書き込まれています。実行の後も、stg-node1にはどちらのファイルもなく、prodの3台は`/etc/gitops-env.conf`がないまま、`/etc/drift-check-target.conf`の時刻も実行前と同じです。

devのインベントリには、devのtfstateから作ったdev-node1しか入りません。そのため、devに向けた`ansible-playbook`の実行は、stg・prodのコンテナには届きません。この実行は、まだコミットしていない作業用のブランチのコードで行ったもので、mainのコードでの実行は、この後に確かめます。

### パイプラインを、環境ごとのインベントリと鍵に向ける

この段階でも、パイプラインが扱う環境はprodだけです。ワークフローの`-i dynamic_inventory.py`を`-i inventories/prod`に、鍵の書き出し先と削除先を`keys/prod/`に直します。ホステッドランナーの2つのワークフローも、同じように直します（`drift-check.yml`の改ざんの注入と、`e2e-provisioning-test.yml`のTestinfraが使う鍵のパスを含みます）。

#### ■ 検証内容：ワークフローを直し、prodの確認モードを実行する

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
W=".github/workflows/gitops-pipeline.yml .github/workflows/gitops-apply.yml .github/workflows/drift-check.yml .github/workflows/e2e-provisioning-test.yml"
sed -i 's|-i dynamic_inventory\.py|-i inventories/prod|g' $W
sed -i 's|chmod +x dynamic_inventory\.py|chmod +x inventories/terraform_inventory.py|' $W
sed -i 's|^\( *\)terraform -chdir=\.\./terraform/envs/prod output -raw generated_private_key > id_ed25519_generated$|\1mkdir -p keys/prod\n\1terraform -chdir=../terraform/envs/prod output -raw generated_private_key > keys/prod/id_ed25519_generated|' $W
sed -i 's|ls -l id_ed25519_generated|ls -l keys/prod/id_ed25519_generated|; s|rm -f id_ed25519_generated|rm -f keys/prod/id_ed25519_generated|; s|-i \./id_ed25519_generated|-i ./keys/prod/id_ed25519_generated|; s|\./ansible/id_ed25519_generated|./ansible/keys/prod/id_ed25519_generated|' $W
git --no-pager diff -- .github
python3 -c 'import sys, yaml; [yaml.safe_load(open(f)) for f in sys.argv[1:]]; print("yaml ok")' $W
grep -n -E 'dynamic_inventory|id_ed25519_generated|inventories|keys/prod' $W
```

**▼ 実行結果**

```plaintext
（途中省略：差分の表示）
yaml ok
.github/workflows/gitops-pipeline.yml:141:          mkdir -p keys/prod
.github/workflows/gitops-pipeline.yml:142:          terraform -chdir=../terraform/envs/prod output -raw generated_private_key > keys/prod/id_ed25519_generated
.github/workflows/gitops-pipeline.yml:145:        run: ansible-playbook -i inventories/prod site.yml --check --diff
.github/workflows/gitops-pipeline.yml:149:        run: rm -f keys/prod/id_ed25519_generated
.github/workflows/gitops-apply.yml:187:          mkdir -p keys/prod
.github/workflows/gitops-apply.yml:188:          terraform -chdir=../terraform/envs/prod output -raw generated_private_key > keys/prod/id_ed25519_generated
.github/workflows/gitops-apply.yml:191:        run: ansible-playbook -i inventories/prod site.yml --diff
.github/workflows/gitops-apply.yml:195:        run: rm -f keys/prod/id_ed25519_generated
.github/workflows/drift-check.yml:42:        run: chmod +x inventories/terraform_inventory.py
.github/workflows/drift-check.yml:47:          mkdir -p keys/prod
.github/workflows/drift-check.yml:48:          terraform -chdir=../terraform/envs/prod output -raw generated_private_key > keys/prod/id_ed25519_generated
.github/workflows/drift-check.yml:49:          ls -l keys/prod/id_ed25519_generated
.github/workflows/drift-check.yml:52:        run: ansible-playbook -i inventories/prod site.yml
.github/workflows/drift-check.yml:57:          ssh -o StrictHostKeyChecking=no -i ./keys/prod/id_ed25519_generated -p 2231 ansible@127.0.0.1 \
.github/workflows/drift-check.yml:63:          ansible-playbook -i inventories/prod site.yml --check | tee check_result.txt
.github/workflows/drift-check.yml:71:        run: ansible-playbook -i inventories/prod site.yml
.github/workflows/e2e-provisioning-test.yml:42:        run: chmod +x inventories/terraform_inventory.py
.github/workflows/e2e-provisioning-test.yml:47:          mkdir -p keys/prod
.github/workflows/e2e-provisioning-test.yml:48:          terraform -chdir=../terraform/envs/prod output -raw generated_private_key > keys/prod/id_ed25519_generated
.github/workflows/e2e-provisioning-test.yml:49:          ls -l keys/prod/id_ed25519_generated
.github/workflows/e2e-provisioning-test.yml:52:        run: ansible-playbook -i inventories/prod site.yml
.github/workflows/e2e-provisioning-test.yml:66:            --ssh-identity-file=./ansible/keys/prod/id_ed25519_generated \
```

`dynamic_inventory.py`を参照する行はなくなり、鍵のパスはすべて`keys/prod/`になりました。prodのインベントリで確認モードを実行してから、コミットしてプッシュします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
ansible-playbook -i inventories/prod site.yml --check --diff 2>/dev/null | grep -E '^\+env=|changed:|^target-node'
cd ~/iac/docker-lab-ci
git add -A ansible .github
git status --short
git commit -m "GitOps第10回: インベントリと鍵を環境ごとに分け、環境ごとの変数を渡す"
git push -u origin gitops10-inventories
```

**▼ 実行結果**

```plaintext
+env=prod
changed: [target-node1]
+env=prod
changed: [target-node2]
+env=prod
changed: [target-node3]
target-node1               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
M  .github/workflows/drift-check.yml
M  .github/workflows/e2e-provisioning-test.yml
M  .github/workflows/gitops-apply.yml
M  .github/workflows/gitops-pipeline.yml
D  ansible/dynamic_inventory.py
A  ansible/inventories/dev/terraform_inventory.py
A  ansible/inventories/prod/terraform_inventory.py
A  ansible/inventories/stg/terraform_inventory.py
A  ansible/inventories/terraform_inventory.py
A  ansible/roles/common_setup/defaults/main.yml
A  ansible/roles/common_setup/tasks/environment.yml
M  ansible/roles/common_setup/tasks/main.yml
[gitops10-inventories b8a807f] GitOps第10回: インベントリと鍵を環境ごとに分け、環境ごとの変数を渡す
 12 files changed, 81 insertions(+), 52 deletions(-)
（途中省略：作成と削除の一覧、プッシュの表示）
```

#### ■ 結果

prodの確認モードは、3台とも、`/etc/gitops-env.conf`に`env=prod`を書き込む変更を予測しました（`changed=1`）。prodの`group_vars`の値が渡っています。

ところが、`git status`の一覧には、3つの環境の`group_vars/target_nodes.yml`が入っていません。シンボリックリンクの3つは追加されていますが、環境ごとの変数のファイルは、コミットに含まれていませんでした。`git add`は、エラーも警告も出していません。

### .gitignoreの古い規則が、環境ごとの変数を外していた

コミットに入らなかった理由を、`git check-ignore`で確かめます。

#### ■ 検証内容：group_varsが除外された理由を確かめ、規則を外す

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
grep -n 'group_vars' .gitignore
git check-ignore -v ansible/inventories/dev/group_vars/target_nodes.yml; echo "exit_code=$?"
sed -i '/^\*\*\/group_vars\/target_nodes\.yml$/d' .gitignore
git --no-pager diff -- .gitignore
git check-ignore -v ansible/inventories/dev/group_vars/target_nodes.yml; echo "exit_code=$?"
git add .gitignore ansible/inventories
git status --short
git commit -m "GitOps第10回: 環境ごとのgroup_varsをGitに置くため、.gitignoreの除外を外す"
git push
git log --oneline -3
git ls-files ansible/inventories
```

**▼ 実行結果**

```plaintext
13:**/group_vars/target_nodes.yml
.gitignore:13:**/group_vars/target_nodes.yml    ansible/inventories/dev/group_vars/target_nodes.yml
exit_code=0
diff --git a/.gitignore b/.gitignore
index dd09d53..df58aa4 100644
--- a/.gitignore
+++ b/.gitignore
@@ -10,7 +10,6 @@

 # Terraformが実行のたびに生成するファイル
 inventory.ini
-**/group_vars/target_nodes.yml
 id_ed25519_generated

 # テストツールのキャッシュ
exit_code=1
M  .gitignore
A  ansible/inventories/dev/group_vars/target_nodes.yml
A  ansible/inventories/prod/group_vars/target_nodes.yml
A  ansible/inventories/stg/group_vars/target_nodes.yml
[gitops10-inventories e064f7e] GitOps第10回: 環境ごとのgroup_varsをGitに置くため、.gitignoreの除外を外す
 4 files changed, 6 insertions(+), 1 deletion(-)
（途中省略：作成の一覧、プッシュの表示）
e064f7e (HEAD -> gitops10-inventories, origin/gitops10-inventories) GitOps第10回: 環境ごとのgroup_varsをGitに置くため、.gitignoreの除外を外す
b8a807f GitOps第10回: インベントリと鍵を環境ごとに分け、環境ごとの変数を渡す
dad1c82 (origin/main, main) Merge pull request #52 from juehara-crypto/gitops10-envs-dev-stg
ansible/inventories/dev/group_vars/target_nodes.yml
ansible/inventories/dev/terraform_inventory.py
ansible/inventories/prod/group_vars/target_nodes.yml
ansible/inventories/prod/terraform_inventory.py
ansible/inventories/stg/group_vars/target_nodes.yml
ansible/inventories/stg/terraform_inventory.py
ansible/inventories/terraform_inventory.py
```

#### ■ 結果

環境ごとの変数のファイルは、`.gitignore`の13行目の`**/group_vars/target_nodes.yml`で除外されていました。この行は、**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション3で、Terraformの`local_file`が実行のたびに生成していた`group_vars/target_nodes.yml`を、Gitに置かないファイルとして除外したものです。その`local_file`は、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション4で削除しました。生成するものがなくなった後も除外の規則だけが残り、人が書いた環境ごとの変数を、同じファイル名だったために、黙ってGitの外に置いていました。

この行を外すと、3つの`group_vars/target_nodes.yml`は除外されなくなり、別のコミットとしてGitに入りました。

もし気づかずにマージしていれば、Gitのコードを使うパイプラインには、環境ごとの変数が届きません。prodには、ロールの既定値の`unknown`が書き込まれていたことになります。手元では、作業ディレクトリに変数のファイルがあるため、`env=prod`と正しく動いて見えます。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で、`.gitignore`は「Gitの外に置いたもの」の記録だと整理しました。その記録は、置かなくなった理由がなくなっても、自動では消えません。

### パイプラインを通して、prodに適用する

このブランチから、プルリクエスト（`#53`）を作成してマージしました（マージコミット`1728a82`）。マージで起動した「GitOps Pipeline」の実行`#98`では、変更されたパスが次のように判定されました。

**▼ 実行結果（`#53`のマージの「GitOps Pipeline」の実行`#98`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
.github/workflows/drift-check.yml
.github/workflows/e2e-provisioning-test.yml
.github/workflows/gitops-apply.yml
.github/workflows/gitops-pipeline.yml
.gitignore
***/dynamic_inventory.py
***/inventories/dev/group_vars/target_nodes.yml
***/inventories/dev/terraform_inventory.py
***/inventories/prod/group_vars/target_nodes.yml
***/inventories/prod/terraform_inventory.py
***/inventories/stg/group_vars/target_nodes.yml
***/inventories/stg/terraform_inventory.py
***/inventories/terraform_inventory.py
***/roles/common_setup/defaults/main.yml
***/roles/common_setup/tasks/environment.yml
***/roles/common_setup/tasks/main.yml
base=dad1c82a78e461eb7e7c267effde79532ea97fb5
terraform=false
***=true
```

`ansible/`だけの変更なので、`terraform-static`と`terraform-plan`はスキップされ、`ansible-lint`、`molecule`、`ansible-check`が動きました。承認する人が見る材料である`ansible-check`は、`-i inventories/prod`と`keys/prod/`の鍵で、prodの3台への変更を予測しています。

**▼ 実行結果（「GitOps Pipeline」の実行`#98`、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
（途中省略：Pythonのインタープリターに関する警告）
--- before
+++ after: /etc/gitops-env.conf
@@ -0,0 +1 @@
+env=prod

changed: [target-node2]
（途中省略：target-node3とtarget-node1の、同じ内容の差分）
PLAY RECAP *********************************************************************
target-node1               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

**▼ 実行結果（「GitOps Pipeline」の実行`#98`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示、ファイルの一覧）
base=dad1c82a78e461eb7e7c267effde79532ea97fb5
commit=1728a8249c6e693adee96a48184980a0c17bcc9d
terraform=false
***=true
```

Terraformの変更がないため、承認待ちにplanのファイルはありません。この承認待ちを、「GitOps Apply」を、ブランチ「main」、2つの入力を外したまま起動して適用しました（実行`#24`）。`verify`、`ansible-apply`、`clear-pending`が成功し、`discard`と`terraform-apply`はスキップされました。

**▼ 実行結果（「GitOps Apply」の実行`#24`、`verify`ジョブの入口の確認の各ステップから抜粋）**

```plaintext
（ステップ「Check commits came from pull requests」）
1728a8249c6e693adee96a48184980a0c17bcc9d: merge of pull request #53
（ステップ「Check guardrail results」）
***-lint: success
molecule: success
```

**▼ 実行結果（「GitOps Apply」の実行`#24`、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
Run ***-playbook -i inventories/prod site.yml --diff
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before
+++ after: /etc/gitops-env.conf
@@ -0,0 +1 @@
+env=prod

changed: [target-node3]
（途中省略：target-node2とtarget-node1の、同じ内容の差分）
PLAY RECAP *********************************************************************
target-node1               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

承認の材料で予測された`+env=prod`が、そのまま適用されました。Gitに入れたprodの`group_vars`の値が、パイプラインの中でもprodに届いています。

### mainのコードで、dev・stgにそろえる

mainを更新し、mainのコードでdev・stgに実行します。devは、作業用のブランチのコードで実行済みのため、変化がないことを確かめます。stgは、ここで初めてAnsibleを実行します。あわせて、環境ごとに分ける前の古い鍵（`ansible/id_ed25519_generated`）を削除し、それがなくてもprodに接続できることを確かめます。

#### ■ 検証内容：dev・stgへの実行と、終了時点の状態

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline -3
git branch -d gitops10-inventories
git push origin --delete gitops10-inventories
git status --short; echo "git_status_exit_code=$?"
ls -la ~/gitops-pending; echo "exit_code=$?"
ls -l ansible/id_ed25519_generated
rm ansible/id_ed25519_generated
cd ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for e in dev stg; do echo "== $e"; ansible-playbook -i inventories/$e site.yml --diff 2>/dev/null | grep -E '^\+env=|^\+monitored_by=|changed:|: ok='; done
ansible-playbook -i inventories/prod site.yml --check 2>/dev/null | tail -4
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n cat /etc/gitops-env.conf; done
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えと、オブジェクトの受信の表示）
1728a82 (HEAD -> main, origin/main) Merge pull request #53 from juehara-crypto/gitops10-inventories
e064f7e (origin/gitops10-inventories, gitops10-inventories) GitOps第10回: 環境ごとのgroup_varsをGitに置くため、.gitignoreの除外を外す
b8a807f GitOps第10回: インベントリと鍵を環境ごとに分け、環境ごとの変数を渡す
（途中省略：ブランチの削除の表示）
git_status_exit_code=0
ls: cannot access '/home/control/gitops-pending': No such file or directory
exit_code=2
-rw------- 1 control control 387 Oct 10 23:10 ansible/id_ed25519_generated
== dev
dev-node1                  : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== stg
+monitored_by=ansible-drift-check
changed: [stg-node1]
+env=stg
changed: [stg-node1]
stg-node1                  : ok=3    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node1               : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=3    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

== dev-node1
env=dev
== stg-node1
env=stg
== target-node1
env=prod
== target-node2
env=prod
== target-node3
env=prod
```

ホステッドランナーの2つのワークフローも、マージ後のmainで手動で起動しました。「Drift Check」の実行`#211`は、`-i inventories/prod`で動き、改ざんを注入したtarget-node1だけを`changed=1`として検知しました（`DEBUG: CHANGED value is [1]`）。「E2E Provisioning Test」の実行`#19`は、`keys/prod/`の鍵でTestinfraが接続して`6 passed`となり、最後のステップは、**[セクション3](#3-tfstateを環境ごとに分ける)** と同じく、コンテナ3台の作り直しを検出して止まりました。

#### ■ 結果

mainのコードで実行したdevは`changed=0`で、作業用のブランチで実行した結果と、mainのコードが一致していることが確かめられました。stgは初めての実行で、2つのファイルが置かれました（`changed=2`）。5台の`/etc/gitops-env.conf`は、`env=dev`、`env=stg`、`env=prod`（3台）です。同じロールに、環境ごとの値だけが違って渡っています。

古い鍵を削除しても、prodの確認モードは3台とも`changed=0`でした。インベントリのスクリプトが渡す`keys/prod/`の鍵で接続していて、`ansible.cfg`の`private_key_file`は、もう使われていません。

このセクションで確認したことを並べると、次のとおりです。

* インベントリは、`-i inventories/<環境>`で指定したディレクトリの名前で、読むtfstateと使う鍵が決まる形にした。環境の名前として知らない場所から実行するとエラーで終わり、既定でどこかの環境を読むことはない
* 鍵は環境ごとに分かれ、devの鍵ではprodのコンテナに入れなかった。ただし、Ansibleの接続の再利用（`ControlPersist`）が残っている間は、別の鍵を指定しても接続できてしまうため、確かめ方に注意が必要だった
* 環境ごとの値は、インベントリのディレクトリの`group_vars`で、同じロールに渡した
* devに向けた実行は、stg・prodのコンテナには届かなかった
* `.gitignore`に残っていた古い規則が、環境ごとの変数のファイルを黙ってGitの外に置いていた。気づかずにマージしていれば、パイプラインには変数が届かなかった
* prodへの変更は、承認の材料の段階で`+env=prod`として予測され、承認ゲートを通して、そのまま適用された

ただし、パイプラインが扱う環境は、まだprodだけです。dev・stgへの適用は手元から行っていて、devで試した変更を、stg、prodの順に届けることは、パイプラインの構造としては何も強制されていません。次のセクションでは、承認ゲートを環境ごとに持たせ、昇格の順序と条件をワークフローで強制します。

---

[↑ 目次に戻る](#-目次)

---

## 5. 昇格の順序と条件をワークフローで強制する

**[セクション4](#4-インベントリと変数を環境ごとに分ける)** までで、環境ごとのtfstateとインベントリがそろいました。ここでは、mainにマージした変更を、dev、stg、prodの順にだけ適用できるようにします。順番と条件は、人の注意に任せず、ワークフローの中で確かめます。

### 承認待ちを、環境ごとに作る

**[セクション4](#4-インベントリと変数を環境ごとに分ける)** の終了時点のパイプラインは、prodだけを扱う形でした。mainへのマージで、承認待ちを`~/gitops-pending/`に1つだけ作り、「GitOps Apply」がそれをprodに適用します。3つの環境に広げるには、次の3つが足りません。

* 環境ごとの承認待ち。1回のマージに対して、dev、stg、prodのそれぞれに、適用を待つplanとコミットが要る
* 環境ごとの「最後に適用したコミット」。stgに適用してよいかは、devに同じコミットを適用し終えたかで決まる
* 適用する環境の指定。「GitOps Apply」を起動するときに、どの環境の承認待ちを適用するかを選ぶ

承認待ちは、`~/gitops-pending/<環境>/`の下に分けます。中身は、これまでと同じく、planのファイル（`tfplan`）、planを作ったコミット（`commit`）、TerraformとAnsibleのどちらに変更があったか（`terraform`と`ansible`）です。

最後に適用したコミットは、tfstateと同じPostgreSQLに表（`gitops.applied`）を作り、適用するたびに1行を足して記録します。この置き場所にした理由は、次の3つです。

* tfstateの置き場所として、すでにself-hostedランナーから接続でき、接続文字列もSecrets（`PG_CONN_STR`）にある
* 行を足していくだけなので、どの環境に、いつ、どの実行が、どのコミットを適用したかの履歴が残る
* Gitのタグで記録する方法と違い、「GitOps Apply」に、リポジトリへの書き込みの権限を与えなくて済む（`contents: read`のまま）

#### ■ 検証内容：最後に適用したコミットを記録する表を作る

self-hostedランナーと同じ制御ノードに、PostgreSQLのクライアント（`psql`）を入れ、表を作ります。

**実行コマンド**

```plaintext
sudo apt-get update > /dev/null
sudo apt-get install -y postgresql-client > /dev/null; echo "install_exit_code=$?"
command -v psql
psql --version
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
psql "$PG_CONN_STR" -X -v ON_ERROR_STOP=1 <<'EOF'
CREATE SCHEMA IF NOT EXISTS gitops;
CREATE TABLE IF NOT EXISTS gitops.applied (
  id         bigserial PRIMARY KEY,
  env        text NOT NULL CHECK (env IN ('dev', 'stg', 'prod')),
  commit_sha text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL
);
EOF
echo "create_exit_code=$?"
psql "$PG_CONN_STR" -X -c '\d gitops.applied'
```

**▼ 実行結果**

```plaintext
（途中省略：パッケージの取得とインストールの表示）
install_exit_code=0
/usr/bin/psql
psql (PostgreSQL) 14.24 (Ubuntu 14.24-0ubuntu0.22.04.1)
CREATE SCHEMA
CREATE TABLE
create_exit_code=0
                                          Table "gitops.applied"
   Column   |           Type           | Collation | Nullable |                  Default
------------+--------------------------+-----------+----------+--------------------------------------------
 id         | bigint                   |           | not null | nextval('gitops.applied_id_seq'::regclass)
 env        | text                     |           | not null |
 commit_sha | text                     |           | not null |
 applied_at | timestamp with time zone |           | not null | now()
 applied_by | text                     |           | not null |
Indexes:
    "applied_pkey" PRIMARY KEY, btree (id)
Check constraints:
    "applied_env_check" CHECK (env = ANY (ARRAY['dev'::text, 'stg'::text, 'prod'::text]))
```

`env`には、`CHECK`の制約で、`dev`・`stg`・`prod`以外の値を入れられないようにしました。`applied_by`には、適用した「GitOps Apply」の実行のURLを入れます。

今の3つの環境は、どれも`main`の`1728a82`（**[セクション4](#4-インベントリと変数を環境ごとに分ける)** の最後のマージ）の状態です。これを、最初の記録として入れます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
git log --oneline -1
C=$(git rev-parse HEAD); echo "C=$C"
psql "$PG_CONN_STR" -X -q -v ON_ERROR_STOP=1 -v sha="$C" <<'EOF'
INSERT INTO gitops.applied (env, commit_sha, applied_by) VALUES
  ('dev',  :'sha', 'initial'),
  ('stg',  :'sha', 'initial'),
  ('prod', :'sha', 'initial');
EOF
echo "insert_exit_code=$?"
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha, applied_at, applied_by FROM gitops.applied ORDER BY id;'
```

**▼ 実行結果**

```plaintext
1728a82 (HEAD -> main, origin/main) Merge pull request #53 from juehara-crypto/gitops10-inventories
C=1728a8249c6e693adee96a48184980a0c17bcc9d
insert_exit_code=0
 id | env  |                commit_sha                |          applied_at           | applied_by
----+------+------------------------------------------+-------------------------------+------------
  1 | dev  | 1728a8249c6e693adee96a48184980a0c17bcc9d | 2026-10-11 07:19:38.783749+00 | initial
  2 | stg  | 1728a8249c6e693adee96a48184980a0c17bcc9d | 2026-10-11 07:19:38.783749+00 | initial
  3 | prod | 1728a8249c6e693adee96a48184980a0c17bcc9d | 2026-10-11 07:19:38.783749+00 | initial
(3 rows)
```

ワークフローからは、表を直接読み書きせず、`.github/scripts/applied.sh`を通します。`last`で環境の最後の記録を読み、`record`で1行を足します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops10-promotion
cat > .github/scripts/applied.sh <<'EOF'
（ファイルの内容。下のcat -nの結果と同じ）
EOF
chmod +x .github/scripts/applied.sh
cat -n .github/scripts/applied.sh
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for e in dev stg prod; do echo "$e: $(.github/scripts/applied.sh last $e)"; done
.github/scripts/applied.sh last qa; echo "exit_code=$?"
.github/scripts/applied.sh record dev; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops10-promotion'
     1  #!/usr/bin/env bash
     2  # 環境ごとの「最後に適用したコミット」を、PostgreSQLのgitops.appliedで読み書きする
     3  #   applied.sh last <環境>                        最後に適用したコミットを表示する
     4  #   applied.sh record <環境> <コミット> <記録者>  適用したコミットを1行追記する
     5  # 終了コード 0=成功、1=記録がない、2=使い方の誤り
     6  set -euo pipefail
     7
     8  usage() {
     9    echo "usage: applied.sh last <dev|stg|prod> | applied.sh record <dev|stg|prod> <commit> <applied_by>" >&2
    10    exit 2
    11  }
    12
    13  [ $# -ge 2 ] || usage
    14  case "$2" in
    15    dev|stg|prod) ;;
    16    *) usage ;;
    17  esac
    18
    19  case "$1" in
    20    last)
    21      [ $# -eq 2 ] || usage
    22      sha=$(printf '%s\n' "SELECT commit_sha FROM gitops.applied WHERE env = :'env' ORDER BY id DESC LIMIT 1;" \
    23        | psql "$PG_CONN_STR" -X -q -A -t -v ON_ERROR_STOP=1 -v env="$2")
    24      if [ -z "$sha" ]; then
    25        echo "no applied record for $2" >&2
    26        exit 1
    27      fi
    28      echo "$sha"
    29      ;;
    30    record)
    31      [ $# -eq 4 ] || usage
    32      printf '%s\n' "INSERT INTO gitops.applied (env, commit_sha, applied_by) VALUES (:'env', :'sha', :'by');" \
    33        | psql "$PG_CONN_STR" -X -q -v ON_ERROR_STOP=1 -v env="$2" -v sha="$3" -v by="$4"
    34      ;;
    35    *)
    36      usage
    37      ;;
    38  esac
dev: 1728a8249c6e693adee96a48184980a0c17bcc9d
stg: 1728a8249c6e693adee96a48184980a0c17bcc9d
prod: 1728a8249c6e693adee96a48184980a0c17bcc9d
usage: applied.sh last <dev|stg|prod> | applied.sh record <dev|stg|prod> <commit> <applied_by>
exit_code=2
usage: applied.sh last <dev|stg|prod> | applied.sh record <dev|stg|prod> <commit> <applied_by>
exit_code=2
```

14〜17行目で、環境の名前を`dev`・`stg`・`prod`に限ります。22行目と32行目のSQLには、値を文字列として埋め込まず、`psql`の変数（`:'env'`など）で渡します。`psql`は、`:'変数名'`を、引用符で囲んだ値に置き換えるため、値に引用符が含まれていても、SQLの文が壊れません。3つの環境は、どれも`1728a82`を返しました。知らない環境の名前（`qa`）や、引数が足りない`record`は、使い方の誤りとして終了コード`2`で終わります。

#### ■ 検証内容：パイプラインに、環境ごとの承認待ちを作らせる

「GitOps Pipeline」を、次のように書き換えます。

* `terraform-static`と`terraform-plan`で、3つの環境を順に扱う。書式のチェック（`terraform fmt`）だけは、これまでどおり`terraform/`で1回実行する
* `ansible-check`で、3つの環境の鍵を書き出し、環境ごとに`--check --diff`を実行する
* mainへのマージ（`push`）では、変更の検出の基準を、各環境に最後に適用したコミットにする
* `record-pending`で、3つの環境の承認待ちを作る

**▼ 書き換えた後の`.github/workflows/gitops-pipeline.yml`（`changes`ジョブ、抜粋）**

```plaintext
    21	  changes:
    22	    runs-on: [self-hosted, Linux, X64]
    23	    outputs:
    24	      terraform: ${{ steps.filter.outputs.terraform }}
    25	      ansible: ${{ steps.filter.outputs.ansible }}
    26	    steps:
    27	      - uses: actions/checkout@v4
    28	        with:
    29	          fetch-depth: 0
    30	      - name: Detect changed paths
    31	        id: filter
    32	        env:
    33	          EVENT_NAME: ${{ github.event_name }}
    34	          BASE_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}
    35	          HEAD_SHA: ${{ github.sha }}
    36	        run: |
    37	          set -o pipefail
    38	          bases="$BASE_SHA"
    39	          if [ "$EVENT_NAME" = "push" ]; then
    40	            bases=""
    41	            for e in dev stg prod; do
    42	              applied=$(.github/scripts/applied.sh last "$e")
    43	              echo "last applied ($e): $applied"
    44	              bases="$bases $applied"
    45	            done
    46	          fi
    47	          for b in $bases; do
    48	            git diff --name-only "$b" "$HEAD_SHA"
    49	          done | sort -u | tee "$RUNNER_TEMP/changed_files.txt"
    50	          if grep -q '^terraform/' "$RUNNER_TEMP/changed_files.txt"; then
    51	            echo "terraform=true" >> "$GITHUB_OUTPUT"
    52	          else
    53	            echo "terraform=false" >> "$GITHUB_OUTPUT"
    54	          fi
    55	          if grep -q '^ansible/' "$RUNNER_TEMP/changed_files.txt"; then
    56	            echo "ansible=true" >> "$GITHUB_OUTPUT"
    57	          else
    58	            echo "ansible=false" >> "$GITHUB_OUTPUT"
    59	          fi
    60	          cat "$GITHUB_OUTPUT"
```

プルリクエストでは、これまでどおり、プルリクエストの基準のコミットとの差分を見ます（38行目）。mainへのマージでは、39〜46行目で、3つの環境の最後に適用したコミットを読み、47〜49行目で、そのそれぞれからの差分を合わせます。

これまでのように、マージの直前のコミット（`github.event.before`）との差分だけを見ると、承認待ちが作られなかったマージや、まだ適用していないマージの変更が、判定から漏れます。環境ごとに適用が進む形では、「その環境で、まだ適用していない変更があるか」を判定の基準にします。37行目の`set -o pipefail`は、`applied.sh`や`git diff`が失敗したときに、空の差分として先に進まないためのものです。

**▼ 書き換えた後の`.github/workflows/gitops-pipeline.yml`（`terraform-plan`ジョブのステップ「Terraform plan」と、`record-pending`ジョブ、抜粋）**

```plaintext
   139	      - name: Terraform plan
   140	        working-directory: terraform/envs
   141	        env:
   142	          EVENT_NAME: ${{ github.event_name }}
   143	        run: |
   144	          for e in dev stg prod; do
   145	            echo "== $e"
   146	            if [ "$EVENT_NAME" = "push" ]; then
   147	              mkdir -p -m 700 "$HOME/gitops-pending" "$HOME/gitops-pending/$e"
   148	              (umask 077; terraform -chdir="$e" plan -input=false -out="$HOME/gitops-pending/$e/tfplan")
   149	            else
   150	              terraform -chdir="$e" plan -input=false
   151	            fi
   152	          done
（途中省略：ansible-checkジョブ）
   189	  record-pending:
   190	    needs: [changes, terraform-plan, ansible-check]
   191	    if: ${{ !cancelled() && github.event_name == 'push' && needs.terraform-plan.result != 'failure' && needs.ansible-check.result != 'failure' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true') }}
   192	    runs-on: [self-hosted, Linux, X64]
   193	    steps:
   194	      - name: Record pending approval
   195	        env:
   196	          HEAD_SHA: ${{ github.sha }}
   197	          TF_CHANGED: ${{ needs.changes.outputs.terraform }}
   198	          ANSIBLE_CHANGED: ${{ needs.changes.outputs.ansible }}
   199	        run: |
   200	          umask 077
   201	          for e in dev stg prod; do
   202	            d="$HOME/gitops-pending/$e"
   203	            mkdir -p -m 700 "$HOME/gitops-pending" "$d"
   204	            if [ "$TF_CHANGED" != "true" ]; then
   205	              rm -f "$d/tfplan"
   206	            fi
   207	            echo "$HEAD_SHA" > "$d/commit"
   208	            echo "$TF_CHANGED" > "$d/terraform"
   209	            echo "$ANSIBLE_CHANGED" > "$d/ansible"
   210	            echo "== $e"
   211	            ls -l "$d"
   212	            if [ -f "$d/tfplan" ]; then sha256sum "$d/tfplan"; fi
   213	            for f in commit terraform ansible; do echo "$f=$(cat "$d/$f")"; done
   214	          done
```

1回のマージで、3つの環境の承認待ちを同時に作ります（201〜214行目）。これまで承認待ちに記録していた基準のコミット（`base`）は、記録しないことにしました。どこからの変更を確かめるかは、適用するときに、その環境の最後に適用したコミットから決めるためです。

「GitOps Apply」の書き換えは、次の「前の環境に適用したコミットでなければ、適用しない」で示します。`applied.sh`と2つのワークフローをコミットし、プルリクエスト（`#54`）を作成しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git add .github/scripts/applied.sh .github/workflows/gitops-pipeline.yml .github/workflows/gitops-apply.yml
git status --short
git commit -m "GitOps第10回: 環境ごとの承認待ちと昇格の順序、最後に適用したコミットの記録を加える"
git push -u origin gitops10-promotion
```

**▼ 実行結果**

```plaintext
A  .github/scripts/applied.sh
M  .github/workflows/gitops-apply.yml
M  .github/workflows/gitops-pipeline.yml
[gitops10-promotion 0107c07] GitOps第10回: 環境ごとの承認待ちと昇格の順序、最後に適用したコミットの記録を加える
 3 files changed, 193 insertions(+), 81 deletions(-)
 create mode 100755 .github/scripts/applied.sh
（途中省略：プッシュの表示）
```

**▼ 実行結果（プルリクエスト`#54`の「GitOps Pipeline」の実行`#99`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  env:
（途中省略：Secretsの環境変数の表示）
    EVENT_NAME: pull_request
    BASE_SHA: 1728a8249c6e693adee96a48184980a0c17bcc9d
    HEAD_SHA: 30c30b5effbbec20d06850f313b229b145f9b6f9
.github/scripts/applied.sh
.github/workflows/gitops-apply.yml
.github/workflows/gitops-pipeline.yml
terraform=false
***=false
```

`HEAD_SHA`の`30c30b5`は、GitHubがプルリクエストの確認のために作る、仮のマージコミットです。変更は`.github/`の下だけなので、`changes`以外のジョブはすべてスキップされました。`#54`をマージしました（マージコミット`343cdf2`）。

**▼ 実行結果（`#54`のマージの「GitOps Pipeline」の実行`#100`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  env:
（途中省略：Secretsの環境変数の表示）
    EVENT_NAME: push
    BASE_SHA: 1728a8249c6e693adee96a48184980a0c17bcc9d
    HEAD_SHA: 343cdf2e5fea3adbe7f923976f0ff6fa284f51bf
last applied (dev): 1728a8249c6e693adee96a48184980a0c17bcc9d
last applied (stg): 1728a8249c6e693adee96a48184980a0c17bcc9d
last applied (prod): 1728a8249c6e693adee96a48184980a0c17bcc9d
.github/scripts/applied.sh
.github/workflows/gitops-apply.yml
.github/workflows/gitops-pipeline.yml
terraform=false
***=false
```

マージの実行では、3つの環境の最後に適用したコミット（どれも`1728a82`）を基準に、差分を取りました。`terraform/`と`ansible/`に変更がないため、承認待ちは作られていません（制御ノードの`~/gitops-pending`も、作られないままでした）。

#### ■ 検証内容：変更をマージして、3つの環境の承認待ちを作る

昇格を確かめるための変更として、**[セクション4](#4-インベントリと変数を環境ごとに分ける)** で作った`/etc/gitops-env.conf`に、1行を足します。この変更は、5台すべてのコンテナに差分を生みます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops10-promotion-test
sed -i 's/env={{ common_setup_env }}\\n/env={{ common_setup_env }}\\npromotion=dev-stg-prod\\n/' ansible/roles/common_setup/tasks/environment.yml
git diff
git add ansible/roles/common_setup/tasks/environment.yml
git commit -m "GitOps第10回: 昇格の確認用に、環境ファイルへ1行足す"
git push -u origin gitops10-promotion-test
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops10-promotion-test'
diff --git a/ansible/roles/common_setup/tasks/environment.yml b/ansible/roles/common_setup/tasks/environment.yml
index 10513db..43fcfe2 100644
--- a/ansible/roles/common_setup/tasks/environment.yml
+++ b/ansible/roles/common_setup/tasks/environment.yml
@@ -3,5 +3,5 @@
   become: true
   ansible.builtin.copy:
     dest: /etc/gitops-env.conf
-    content: "env={{ common_setup_env }}\n"
+    content: "env={{ common_setup_env }}\npromotion=dev-stg-prod\n"
     mode: "0644"
[gitops10-promotion-test ca46c71] GitOps第10回: 昇格の確認用に、環境ファイルへ1行足す
 1 file changed, 1 insertion(+), 1 deletion(-)
（途中省略：プッシュの表示）
```

このブランチから、プルリクエスト（`#55`）を作成しました。確認の実行（`#101`）では、`ansible-lint`、`molecule`、`ansible-check`が成功し、Terraformの3つのジョブと`record-pending`はスキップされました。

**▼ 実行結果（プルリクエスト`#55`の「GitOps Pipeline」の実行`#101`、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
== dev
（途中省略：PLAYとTASKの表示、Pythonのインタープリターに関する警告）
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before: /etc/gitops-env.conf
+++ after: /etc/gitops-env.conf
@@ -1 +1,2 @@
 env=dev
+promotion=dev-stg-prod

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   

== stg
（途中省略：devと同じ形の表示。差分はenv=stgの次の行に+promotion=dev-stg-prod）
stg-node1                  : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   

== prod
（途中省略：devと同じ形の表示。差分は3台ともenv=prodの次の行に+promotion=dev-stg-prod）
target-node1               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

3つの環境の5台すべてで、`+promotion=dev-stg-prod`の差分が予測されました。`#55`をマージしました（マージコミット`29101ac`）。

**▼ 実行結果（`#55`のマージの「GitOps Pipeline」の実行`#102`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  env:
（途中省略：Secretsの環境変数の表示）
    EVENT_NAME: push
    BASE_SHA: 343cdf2e5fea3adbe7f923976f0ff6fa284f51bf
    HEAD_SHA: 29101acb5228cd23e5b1ffba630c09b5c832170e
last applied (dev): 1728a8249c6e693adee96a48184980a0c17bcc9d
last applied (stg): 1728a8249c6e693adee96a48184980a0c17bcc9d
last applied (prod): 1728a8249c6e693adee96a48184980a0c17bcc9d
***/roles/common_setup/tasks/environment.yml
.github/scripts/applied.sh
.github/workflows/gitops-apply.yml
.github/workflows/gitops-pipeline.yml
terraform=false
***=true
```

マージの直前のコミット（`BASE_SHA`の`343cdf2`）は使われず、3つの環境の最後に適用したコミット（`1728a82`）が基準になりました。そのため、`#54`で変えた`.github/`の3つのファイルも、まだどの環境にも適用していない変更として、一覧に入っています。マージの直前のコミットとの差分だけなら、一覧は`environment.yml`の1つだけでした。今回は判定の結果は変わりませんが、もし`#54`が`terraform/`を変えていたら、その変更は判定から漏れていたことになります。

**▼ 実行結果（「GitOps Pipeline」の実行`#102`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
== dev
total 12
-rw------- 1 control control  5 Oct 11 07:55 ***
-rw------- 1 control control 41 Oct 11 07:55 commit
-rw------- 1 control control  6 Oct 11 07:55 terraform
commit=29101acb5228cd23e5b1ffba630c09b5c832170e
terraform=false
***=true
== stg
（途中省略：devと同じ内容）
== prod
（途中省略：devと同じ内容）
```

#### ■ 結果

1回のマージで、dev、stg、prodの3つの承認待ちが、同じコミット（`29101ac`）について作られました。Terraformに変更がないため、どの環境にも`tfplan`はありません。

変更の検出は、マージの直前のコミットではなく、各環境に最後に適用したコミットを基準にするようになりました。承認待ちが作られなかった`#54`の変更も、まだ適用していない変更として、次の判定に引き継がれています。

### 前の環境に適用したコミットでなければ、適用しない

「GitOps Apply」を、次のように書き換えました。

**▼ 書き換えた後の`.github/workflows/gitops-apply.yml`（入力と環境変数、抜粋）**

```plaintext
     1	name: GitOps Apply
     2	
     3	on:
     4	  workflow_dispatch:
     5	    inputs:
     6	      environment:
     7	        description: '適用する環境（dev、stg、prodの順にだけ適用できる）'
     8	        type: choice
     9	        options:
    10	          - dev
    11	          - stg
    12	          - prod
    13	        default: dev
    14	      discard_pending:
    15	        description: '選んだ環境の承認待ちを、適用せずに破棄する'
    16	        type: boolean
    17	        default: false
    18	      allow_destroy:
    19	        description: '削除と作り直しを含むplanの適用を許可する（stgとprodで使う。devでは入力なしで許可する）'
    20	        type: boolean
    21	        default: false
（途中省略）
    32	env:
    33	  TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
    34	  TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
    35	  PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
    36	  TARGET_ENV: ${{ inputs.environment }}
```

起動するときに、6〜13行目の`environment`で、適用する環境を選びます。選択肢の中からしか選べず、既定値はdevです。選んだ環境は、36行目で`TARGET_ENV`に入れ、各ジョブはこの値で、承認待ちのディレクトリ、`terraform/envs/<環境>`、`inventories/<環境>`を決めます。`allow_destroy`は、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** から使っている入力で、このセクションの後半で、環境ごとの扱いを決めます。

**▼ 書き換えた後の`.github/workflows/gitops-apply.yml`（`verify`ジョブの入口の確認、抜粋）**

```plaintext
    76	      - name: Read pending approval
    77	        id: pending
    78	        run: |
    79	          d="$HOME/gitops-pending/$TARGET_ENV"
    80	          if [ ! -f "$d/commit" ]; then
    81	            echo "::error::no pending approval for $TARGET_ENV"
    82	            exit 1
    83	          fi
    84	          ls -l "$d"
    85	          for f in commit terraform ansible; do echo "$f=$(cat "$d/$f")"; echo "$f=$(cat "$d/$f")" >> "$GITHUB_OUTPUT"; done
    86	          if [ "$(cat "$d/commit")" != "$GITHUB_SHA" ]; then
    87	            echo "::error::pending plan was made from $(cat "$d/commit"), but main is $GITHUB_SHA"
    88	            exit 1
    89	          fi
    90	      - name: Check promotion order
    91	        run: |
    92	          case "$TARGET_ENV" in
    93	            dev)
    94	              echo "dev is the first environment"
    95	              exit 0
    96	              ;;
    97	            stg) prev=dev ;;
    98	            prod) prev=stg ;;
    99	          esac
   100	          prev_applied=$(.github/scripts/applied.sh last "$prev")
   101	          echo "last applied ($prev): $prev_applied"
   102	          if [ "$prev_applied" != "$GITHUB_SHA" ]; then
   103	            echo "::error::$GITHUB_SHA has not been applied to $prev yet"
   104	            exit 1
   105	          fi
   106	          echo "$GITHUB_SHA has been applied to $prev"
   107	      - name: Check commits came from pull requests
   108	        env:
   109	          GH_TOKEN: ${{ github.token }}
   110	        run: |
   111	          base=$(.github/scripts/applied.sh last "$TARGET_ENV")
   112	          echo "last applied ($TARGET_ENV): $base"
   113	          ng=0
   114	          for c in $(git rev-list --first-parent "$base..$GITHUB_SHA"); do
（途中省略：これまでと同じ、各コミットがプルリクエストのマージかの確認）
   124	          done
   125	          exit $ng
```

76〜89行目は、これまでの承認待ちの読み込みを、選んだ環境のディレクトリに向けたものです。90〜106行目の「Check promotion order」が、昇格の順序の確認です。stgなら、devに最後に適用したコミットが、今のmainのコミットと同じかを確かめます。prodなら、stgについて同じことを確かめます。

107〜125行目の、マージのたびにプルリクエストを通ったかを確かめるステップは、確かめる範囲の始まりを、承認待ちの`base`から、その環境に最後に適用したコミット（111行目）に変えました。stgやprodは、devより遅れて適用されるため、その間に複数のマージが積み重なることがあります。その環境に、まだ適用していないマージを、すべて確かめるためです。

**▼ 書き換えた後の`.github/workflows/gitops-apply.yml`（`record-applied`ジョブ、抜粋）**

```plaintext
   227	  record-applied:
   228	    needs: [verify, terraform-apply, ansible-apply]
   229	    if: ${{ !cancelled() && needs.verify.result == 'success' && needs.terraform-apply.result != 'failure' && needs.ansible-apply.result != 'failure' }}
   230	    runs-on: [self-hosted, Linux, X64]
   231	    steps:
   232	      - uses: actions/checkout@v4
   233	      - name: Record applied commit
   234	        run: |
   235	          .github/scripts/applied.sh record "$TARGET_ENV" "$GITHUB_SHA" "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
   236	          echo "last applied ($TARGET_ENV): $(.github/scripts/applied.sh last "$TARGET_ENV")"
   237	      - name: Clear pending approval
   238	        run: |
   239	          rm -rf "$HOME/gitops-pending/$TARGET_ENV"
   240	          echo "pending approval for $TARGET_ENV cleared"
```

適用が成功したら、その環境に、適用したコミットと実行のURLを記録し、その環境の承認待ちだけを消します。ほかの環境の承認待ちは残ります。

#### ■ 検証内容：devに適用する

prodを先に起動して、止まることを確かめるつもりでした。ところが、最初の3回（`#25`〜`#27`）は、どれも`TARGET_ENV: dev`で動いていました。起動するときのフォームの選択欄が、既定値の`dev`のまま実行されたためと考えています。結果として、この3回で、devへの適用と、承認待ちを使い終えた後の動きを確かめることになりました。

**▼ 実行結果（「GitOps Apply」の実行`#25`、`verify`ジョブのステップ「Read pending approval」と「Check promotion order」から抜粋）**

```plaintext
（ステップ「Read pending approval」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
    TARGET_ENV: dev
total 12
-rw------- 1 control control  5 Oct 11 07:55 ***
-rw------- 1 control control 41 Oct 11 07:55 commit
-rw------- 1 control control  6 Oct 11 07:55 terraform
commit=29101acb5228cd23e5b1ffba630c09b5c832170e
terraform=false
***=true
（ステップ「Check promotion order」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
dev is the first environment
```

**▼ 実行結果（「GitOps Apply」の実行`#25`、`ansible-apply`ジョブのステップ「Ansible playbook」と、`record-applied`ジョブの2つのステップから抜粋）**

```plaintext
（ステップ「Ansible playbook」）
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before: /etc/gitops-env.conf
+++ after: /etc/gitops-env.conf
@@ -1 +1,2 @@
 env=dev
+promotion=dev-stg-prod

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
（ステップ「Record applied commit」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
last applied (dev): 29101acb5228cd23e5b1ffba630c09b5c832170e
（ステップ「Clear pending approval」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
pending approval for dev cleared
```

**▼ 実行結果（「GitOps Apply」の実行`#26`、`verify`ジョブのステップ「Read pending approval」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
    TARGET_ENV: dev
Error: no pending approval for dev
Error: Process completed with exit code 1.
```

`#27`も、`#26`と同じ結果でした。手元で、この時点の状態を確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
ls ~/gitops-pending
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha, applied_by FROM gitops.applied ORDER BY id;'
for n in dev-node1 stg-node1 target-node1; do echo "== $n"; docker exec $n cat /etc/gitops-env.conf; done
```

**▼ 実行結果**

```plaintext
prod  stg
 id | env  |                commit_sha                |                                     applied_by
----+------+------------------------------------------+-------------------------------------------------------------------------------------
  1 | dev  | 1728a8249c6e693adee96a48184980a0c17bcc9d | initial
  2 | stg  | 1728a8249c6e693adee96a48184980a0c17bcc9d | initial
  3 | prod | 1728a8249c6e693adee96a48184980a0c17bcc9d | initial
  4 | dev  | 29101acb5228cd23e5b1ffba630c09b5c832170e | https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/38123223227
(4 rows)

== dev-node1
env=dev
promotion=dev-stg-prod
== stg-node1
env=stg
== target-node1
env=prod
```

devに適用すると、`gitops.applied`にdevの行（`id`が4）が足され、devの承認待ちだけが消えました。stgとprodの承認待ちは残り、stg-node1とtarget-node1のファイルは、変わっていません。承認待ちを使い終えたdevでは、もう一度起動しても、「no pending approval for dev」で止まります。同じ承認待ちを、2回適用することはできません。

#### ■ 検証内容：stgより先に、prodに適用しようとする

フォームの選択欄が`prod`になっていることを確かめてから、起動しました（`#28`）。

**▼ 実行結果（「GitOps Apply」の実行`#28`、`verify`ジョブのステップ「Check branch」と「Check promotion order」から抜粋）**

```plaintext
（ステップ「Check branch」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
    TARGET_ENV: prod
ref=refs/heads/main sha=29101acb5228cd23e5b1ffba630c09b5c832170e environment=prod
（ステップ「Check promotion order」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
    TARGET_ENV: prod
last applied (stg): 1728a8249c6e693adee96a48184980a0c17bcc9d
Error: 29101acb5228cd23e5b1ffba630c09b5c832170e has not been applied to stg yet
Error: Process completed with exit code 1.
```

stgに最後に適用したコミットは`1728a82`のままで、今のmainの`29101ac`ではありません。`verify`ジョブは失敗し、適用と記録のジョブは、すべてスキップされました。

#### ■ 検証内容：stg、prodの順に適用する

stg（`#29`）、prod（`#30`）の順に起動しました。どちらも、`verify`、`ansible-apply`、`record-applied`が成功し、Terraformに変更がないため、`terraform-apply`はスキップされました。

**▼ 実行結果（「GitOps Apply」の実行`#29`、`verify`ジョブのステップ「Check promotion order」と「Check commits came from pull requests」から抜粋）**

```plaintext
（ステップ「Check promotion order」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
    TARGET_ENV: stg
last applied (dev): 29101acb5228cd23e5b1ffba630c09b5c832170e
29101acb5228cd23e5b1ffba630c09b5c832170e has been applied to dev
（ステップ「Check commits came from pull requests」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
last applied (stg): 1728a8249c6e693adee96a48184980a0c17bcc9d
29101acb5228cd23e5b1ffba630c09b5c832170e: merge of pull request #55
343cdf2e5fea3adbe7f923976f0ff6fa284f51bf: merge of pull request #54
```

**▼ 実行結果（「GitOps Apply」の実行`#30`、`verify`ジョブのステップ「Check promotion order」と、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（ステップ「Check promotion order」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
    TARGET_ENV: prod
last applied (stg): 29101acb5228cd23e5b1ffba630c09b5c832170e
29101acb5228cd23e5b1ffba630c09b5c832170e has been applied to stg
（ステップ「Ansible playbook」）
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before: /etc/gitops-env.conf
+++ after: /etc/gitops-env.conf
@@ -1 +1,2 @@
 env=prod
+promotion=dev-stg-prod

changed: [target-node1]
（途中省略：target-node3とtarget-node2の同じ差分）
（途中省略）
target-node1               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

手元で、終了時点の状態を確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
ls -la ~/gitops-pending
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha, applied_by FROM gitops.applied ORDER BY id;'
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n cat /etc/gitops-env.conf; done
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct 11 08:26 .
drwxr-x--- 14 control control 4096 Oct 11 07:55 ..
 id | env  |                commit_sha                |                                     applied_by
----+------+------------------------------------------+-------------------------------------------------------------------------------------
  1 | dev  | 1728a8249c6e693adee96a48184980a0c17bcc9d | initial
  2 | stg  | 1728a8249c6e693adee96a48184980a0c17bcc9d | initial
  3 | prod | 1728a8249c6e693adee96a48184980a0c17bcc9d | initial
  4 | dev  | 29101acb5228cd23e5b1ffba630c09b5c832170e | https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/38123223227
  5 | stg  | 29101acb5228cd23e5b1ffba630c09b5c832170e | https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/38124474563
  6 | prod | 29101acb5228cd23e5b1ffba630c09b5c832170e | https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/38124720089
(6 rows)

== dev-node1
env=dev
promotion=dev-stg-prod
== stg-node1
env=stg
promotion=dev-stg-prod
== target-node1
env=prod
promotion=dev-stg-prod
== target-node2
env=prod
promotion=dev-stg-prod
== target-node3
env=prod
promotion=dev-stg-prod
```

#### ■ 結果

stgは、devに`29101ac`を適用し終えていたため、順序の確認を通りました。プルリクエストを通ったかの確認では、stgに最後に適用した`1728a82`から`29101ac`までの、`#55`と`#54`の2つのマージが確かめられています。devには`#25`で`29101ac`をまとめて適用したため、`#54`のマージも、stgと同じく、この範囲に入っていました。prodも、stgに適用し終えた後には、順序の確認を通りました。

`gitops.applied`には、dev、stg、prodの順に3行が足され、どの行にも、適用した「GitOps Apply」の実行のURLが残っています。承認待ちは空になり、5台すべてに`promotion=dev-stg-prod`が入りました。

1回のマージから作った3つの承認待ちは、前の環境に同じコミットを適用し終えるまで、次の環境に適用できません。適用の順序は、起動する人の注意ではなく、ワークフローの中の記録との比較で守られています。

### 削除と作り直しは、stgとprodでは明示して許可する

**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** で、承認ゲートの入口に、planの判定（`plan-policy.sh`）を置きました。削除や作り直しを含むplanは、判定のスクリプトが終了コード`1`を返して止まり、起動のときに`allow_destroy`を選んだ場合だけ適用できます。

3つの環境では、同じ判定を、環境によって違う重さで扱います。devは、作り直しても困る人が少なく、変更を早く試すための環境です。stgとprodは、作り直しの影響を確かめてから、明示して許可します。判定のスクリプトは変えず、その結果をどう扱うかだけを、ワークフローで環境ごとに分けます。

**▼ 書き換えた後の`.github/workflows/gitops-apply.yml`（`verify`ジョブのステップ「Check plan policy」、抜粋）**

```plaintext
   160	      - name: Check plan policy
   161	        if: steps.pending.outputs.terraform == 'true'
   162	        working-directory: terraform/envs/${{ inputs.environment }}
   163	        env:
   164	          ALLOW_DESTROY: ${{ inputs.allow_destroy }}
   165	        run: |
   166	          sha256sum "$HOME/gitops-pending/$TARGET_ENV/tfplan"
   167	          rc=0
   168	          terraform show -json "$HOME/gitops-pending/$TARGET_ENV/tfplan" | "$GITHUB_WORKSPACE"/.github/scripts/plan-policy.sh || rc=$?
   169	          if [ "$rc" -eq 0 ]; then
   170	            exit 0
   171	          fi
   172	          if [ "$rc" -eq 1 ] && [ "$TARGET_ENV" = "dev" ]; then
   173	            echo "::warning::delete or replace is allowed in dev"
   174	            exit 0
   175	          fi
   176	          if [ "$rc" -eq 1 ] && [ "$ALLOW_DESTROY" = "true" ]; then
   177	            echo "::warning::delete or replace is allowed by allow_destroy"
   178	            exit 0
   179	          fi
   180	          if [ "$rc" -eq 1 ]; then
   181	            echo "::error::plan contains delete or replace; dispatch again with allow_destroy to apply it to $TARGET_ENV"
   182	            exit 1
   183	          fi
   184	          echo "::error::plan policy check failed (exit code $rc)"
   185	          exit 1
```

168行目で、選んだ環境の承認待ちのplanを、これまでと同じ`plan-policy.sh`で判定します。判定が`1`（削除や作り直しを含む）のとき、devなら警告を出して通し（172〜175行目）、stgとprodは`allow_destroy`を選んだときだけ通します（176〜179行目）。判定のスクリプト自体が失敗した場合（`1`以外の終了コード）は、devでも止めます（184〜185行目）。

#### ■ 検証内容：コンテナを作り直す変更をマージする

共通のモジュールのコンテナに、ラベルを1つ足します。`docker_container`のラベルは、変えると作り直しになる属性です。共通のモジュールの変更なので、3つの環境すべてで作り直しのplanになります。

コンテナを作り直すと、SSHのホスト鍵が変わります。この検証環境では、`ansible.cfg`で`host_key_checking = False`にしているため、作り直した後も、Ansibleの接続は失敗しません。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
grep -n -i 'host_key' ansible/ansible.cfg
git switch -c gitops10-replace-test
sed -i '/^resource "docker_container" "targets" {$/a\  labels {\n    label = "gitops.promotion-test"\n    value = "replace"\n  }' terraform/modules/lab_env/main.tf
git diff
terraform fmt -check -recursive terraform; echo "fmt_exit_code=$?"
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for e in dev stg prod; do echo "== $e"; terraform -chdir=terraform/envs/$e plan -input=false -no-color 2>&1 | grep -E 'must be replaced|forces replacement|^Plan:|Error'; done
```

**▼ 実行結果**

```plaintext
2:host_key_checking = False
Switched to a new branch 'gitops10-replace-test'
diff --git a/terraform/modules/lab_env/main.tf b/terraform/modules/lab_env/main.tf
index 57961b9..8819340 100644
--- a/terraform/modules/lab_env/main.tf
+++ b/terraform/modules/lab_env/main.tf
@@ -35,6 +35,10 @@ resource "tls_private_key" "generated" {
 }

 resource "docker_container" "targets" {
+  labels {
+    label = "gitops.promotion-test"
+    value = "replace"
+  }
   for_each = var.nodes
   name     = each.key
   image    = docker_image.this.image_id
fmt_exit_code=0
== dev
  # module.lab_env.docker_container.targets["dev-node1"] must be replaced
      + labels { # forces replacement
Plan: 1 to add, 0 to change, 1 to destroy.
== stg
  # module.lab_env.docker_container.targets["stg-node1"] must be replaced
      + labels { # forces replacement
Plan: 1 to add, 0 to change, 1 to destroy.
== prod
  # module.lab_env.docker_container.targets["target-node1"] must be replaced
      + labels { # forces replacement
  # module.lab_env.docker_container.targets["target-node2"] must be replaced
      + labels { # forces replacement
  # module.lab_env.docker_container.targets["target-node3"] must be replaced
      + labels { # forces replacement
Plan: 3 to add, 0 to change, 3 to destroy.
```

devとstgは1台、prodは3台のコンテナが、作り直しになります。この変更をコミットしてプッシュし、プルリクエスト（`#56`）を作成しました。

**実行コマンド**

```plaintext
git add terraform/modules/lab_env/main.tf
git commit -m "GitOps第10回: 作り直しを含むplanの扱いを確かめるため、コンテナにラベルを足す"
git push -u origin gitops10-replace-test
```

**▼ 実行結果**

```plaintext
[gitops10-replace-test 37ab74d] GitOps第10回: 作り直しを含むplanの扱いを確かめるため、コンテナにラベルを足す
 1 file changed, 4 insertions(+)
（途中省略：プッシュの表示）
```

確認の実行（`#103`）では、`changes`、`terraform-static`、`terraform-plan`、`ansible-check`が成功し、`ansible-lint`、`molecule`、`record-pending`はスキップされました。`#56`をマージしました（マージコミット`f000596`）。

**▼ 実行結果（`#56`のマージの「GitOps Pipeline」の実行`#104`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
== dev
total 28
-rw------- 1 control control     6 Oct 11 08:40 ***
-rw------- 1 control control    41 Oct 11 08:40 commit
-rw------- 1 control control     5 Oct 11 08:40 terraform
-rw------- 1 control control 13660 Oct 11 08:39 tfplan
ce4d4e382c48e1663087f49cebddf547d4dc0cdf575d1780cf7b0fab6278fe4d  /home/control/gitops-pending/dev/tfplan
commit=f000596587d218b8d45877595b41897ed2fec704
terraform=true
***=false
== stg
（途中省略：ファイルの一覧）
c1dde200f7fd07d16f1412037701283af90915803a838238dfd5a509ed64c947  /home/control/gitops-pending/stg/tfplan
commit=f000596587d218b8d45877595b41897ed2fec704
terraform=true
***=false
== prod
（途中省略：ファイルの一覧）
ddfaaf10e09449c50c085dd79312f4a047b28fb6759ad64e9c536e84eba9aa5f  /home/control/gitops-pending/prod/tfplan
commit=f000596587d218b8d45877595b41897ed2fec704
terraform=true
***=false
```

3つの環境に、それぞれのtfstateから作った、別々のplanが保存されました。

#### ■ 検証内容：devに、入力なしで適用する

「GitOps Apply」を、environmentを`dev`、2つの入力を外したまま起動しました（`#31`）。

**▼ 実行結果（「GitOps Apply」の実行`#31`、`verify`ジョブのステップ「Check plan policy」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  env:
（途中省略：Secretsの環境変数の表示）
    TARGET_ENV: dev
    ALLOW_DESTROY: false
ce4d4e382c48e1663087f49cebddf547d4dc0cdf575d1780cf7b0fab6278fe4d  /home/control/gitops-pending/dev/tfplan
BLOCK module.lab_env.docker_container.targets["dev-node1"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
Warning: delete or replace is allowed in dev
```

**▼ 実行結果（「GitOps Apply」の実行`#31`、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
ce4d4e382c48e1663087f49cebddf547d4dc0cdf575d1780cf7b0fab6278fe4d  /home/control/gitops-pending/dev/tfplan
module.lab_env.docker_container.targets["dev-node1"]: Destroying... [id=719ffa75f0aff3db5ccdec8e64d7c761e7fb12c979402d324a40bc0a34a98f48]
module.lab_env.docker_container.targets["dev-node1"]: Destruction complete after 1s
module.lab_env.docker_container.targets["dev-node1"]: Creating...
module.lab_env.docker_container.targets["dev-node1"]: Creation complete after 1s [id=4d0b995fca21346d49de4f1df5137c5b5783bc5e43e613777be81d7ccbfbc077]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
（途中省略：Outputsの表示）
```

**▼ 実行結果（「GitOps Apply」の実行`#31`、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）
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

`plan-policy.sh`は、dev-node1の作り直しを`BLOCK`と判定し（`policy: blocked (1)`）、devのため、警告を出して通りました。承認待ちのplan（`ce4d4e38...`）がそのまま適用され、dev-node1が作り直されています。作り直したコンテナには何も入っていないため、続く`ansible-apply`で、2つのファイルが空の状態から置き直されました（`changed=2`）。

#### ■ 検証内容：stgに、allow_destroyなしと、ありで適用する

environmentを`stg`、2つの入力を外したまま起動しました（`#32`）。

**▼ 実行結果（「GitOps Apply」の実行`#32`、`verify`ジョブのステップ「Check plan policy」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  env:
（途中省略：Secretsの環境変数の表示）
    TARGET_ENV: stg
    ALLOW_DESTROY: false
c1dde200f7fd07d16f1412037701283af90915803a838238dfd5a509ed64c947  /home/control/gitops-pending/stg/tfplan
BLOCK module.lab_env.docker_container.targets["stg-node1"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
Error: plan contains delete or replace; dispatch again with allow_destroy to apply it to stg
Error: Process completed with exit code 1.
```

`verify`ジョブが失敗し、後のジョブはすべてスキップされました。手元で、承認待ちを確かめます。

**実行コマンド**

```plaintext
ls ~/gitops-pending
```

**▼ 実行結果**

```plaintext
prod  stg
```

止まった実行では、承認待ちは消えずに残ります。続けて、`allow_destroy`だけを選ぶつもりで起動した`#33`は、入力を外したままだったため、`#32`と同じく`ALLOW_DESTROY: false`で止まりました。`allow_destroy`を選んで、もう一度起動しました（`#34`）。

**▼ 実行結果（「GitOps Apply」の実行`#34`、`verify`ジョブのステップ「Check plan policy」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  env:
（途中省略：Secretsの環境変数の表示）
    TARGET_ENV: stg
    ALLOW_DESTROY: true
c1dde200f7fd07d16f1412037701283af90915803a838238dfd5a509ed64c947  /home/control/gitops-pending/stg/tfplan
BLOCK module.lab_env.docker_container.targets["stg-node1"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
Warning: delete or replace is allowed by allow_destroy
```

`verify`、`terraform-apply`、`ansible-apply`、`record-applied`が、すべて成功しました。

#### ■ 検証内容：prodに、allow_destroyありで適用する

environmentを`prod`、`allow_destroy`を選んで起動しました（`#35`）。4つのジョブが、すべて成功しています。

**▼ 実行結果（「GitOps Apply」の実行`#35`、`verify`ジョブのステップ「Check plan policy」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  env:
（途中省略：Secretsの環境変数の表示）
    TARGET_ENV: prod
    ALLOW_DESTROY: true
ddfaaf10e09449c50c085dd79312f4a047b28fb6759ad64e9c536e84eba9aa5f  /home/control/gitops-pending/prod/tfplan
BLOCK module.lab_env.docker_container.targets["target-node1"] actions=delete,create reason=replace_because_cannot_update
BLOCK module.lab_env.docker_container.targets["target-node2"] actions=delete,create reason=replace_because_cannot_update
BLOCK module.lab_env.docker_container.targets["target-node3"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (3)
Warning: delete or replace is allowed by allow_destroy
```

手元で、終了時点の状態を確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
ls -la ~/gitops-pending
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha, applied_by FROM gitops.applied ORDER BY id;'
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep node
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n cat /etc/gitops-env.conf; docker inspect $n --format 'label={{index .Config.Labels "gitops.promotion-test"}}'; done
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct 11 09:09 .
drwxr-x--- 14 control control 4096 Oct 11 08:41 ..
 id | env  |                commit_sha                |                                     applied_by
----+------+------------------------------------------+-------------------------------------------------------------------------------------
  1 | dev  | 1728a8249c6e693adee96a48184980a0c17bcc9d | initial
  2 | stg  | 1728a8249c6e693adee96a48184980a0c17bcc9d | initial
  3 | prod | 1728a8249c6e693adee96a48184980a0c17bcc9d | initial
  4 | dev  | 29101acb5228cd23e5b1ffba630c09b5c832170e | https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/38123223227
  5 | stg  | 29101acb5228cd23e5b1ffba630c09b5c832170e | https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/38124474563
  6 | prod | 29101acb5228cd23e5b1ffba630c09b5c832170e | https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/38124720089
  7 | dev  | f000596587d218b8d45877595b41897ed2fec704 | https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/38125758929
  8 | stg  | f000596587d218b8d45877595b41897ed2fec704 | https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/38126629265
  9 | prod | f000596587d218b8d45877595b41897ed2fec704 | https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/38127312503
(9 rows)

target-node1   Up 2 minutes
target-node2   Up 2 minutes
target-node3   Up 2 minutes
stg-node1      Up 13 minutes
dev-node1      Up 28 minutes
== dev-node1
env=dev
promotion=dev-stg-prod
label=replace
== stg-node1
env=stg
promotion=dev-stg-prod
label=replace
== target-node1
env=prod
promotion=dev-stg-prod
label=replace
== target-node2
env=prod
promotion=dev-stg-prod
label=replace
== target-node3
env=prod
promotion=dev-stg-prod
label=replace
```

#### ■ 結果

同じ判定（`policy: blocked`）に対して、devは入力なしで通り、stgは`allow_destroy`がないと止まり、選ぶと通りました。prodも、`allow_destroy`を選んで通っています。どの環境でも、適用されたplanのハッシュ値は、マージのときに承認待ちとして保存したもの（`#104`）と同じです。

5台のコンテナは、dev、stg、prodの順に作り直され、どれにもラベルが付いています。作り直した直後のコンテナには、同じ「GitOps Apply」の中で、Ansibleが設定ファイルを置き直しました。`gitops.applied`には、`f000596`について、dev、stg、prodの3行が足されています。

このラベルは、検証のための変更ですが、mainに残したままにします。外すと、もう一度、5台すべての作り直しになるためです。

### この形で守れること、守れないこと

ここまでの形で、ワークフローが守っていることは、次のとおりです。

* 適用の順序。stgはdevに、prodはstgに、同じコミットを適用し終えるまで、適用できない
* 適用するコードの出どころ。その環境に最後に適用したコミットから、今のmainまでのマージが、すべてプルリクエストを通っている
* 適用するplanの同一性。マージのときに保存したplanを、ハッシュ値を表示したうえで、そのまま適用する
* 削除と作り直しの扱い。stgとprodでは、`allow_destroy`を選ばない限り適用されない
* 適用の記録。どの環境に、どのコミットを、どの実行で適用したかが、`gitops.applied`に残る

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション5では、承認待ちを破棄した変更が、mainにはあるが適用されていない差分として残ることを確かめました。変更の検出の基準を、各環境に最後に適用したコミットにしたことで、こうした差分も、次のマージの判定に含まれるようになります。`#102`で、承認待ちが作られなかった`#54`の変更が一覧に入ったのと同じ動きです。

一方で、次のことは、この形では守れません。

**昇格の途中で、新しいマージがあった場合。** `record-pending`は、マージのたびに3つの環境の承認待ちを、新しいコミットで上書きします。また、承認待ちの読み込み（76〜89行目）は、承認待ちのコミットが今のmainと同じことを求めます。そのため、devまで適用した後に新しいマージがあると、stgとprodには、前のコミットを適用できなくなり、新しいコミットをdevから適用し直すことになります。これは、コードから読み取れる動きで、この回では実際には確かめていません。マージの頻度が高く、prodまでの昇格に時間がかかる運用では、prodに届かない状態が続くことがあります。

**起動する人の選び間違い。** 今回の検証では、prodを選んだつもりの起動が、3回続けて`dev`で動きました。選択欄の既定値を`dev`にしているため、選び忘れたときに適用されるのは、最初の環境です。順序の確認があるため、選び間違いで、stgやprodに先に適用されることはありません。ただし、devには、意図しないタイミングで適用されます。

**誰が、どの環境を承認できるか。** 「GitOps Apply」を起動できる人は、どの環境にも適用できます。環境ごとに承認する人を分けたり、prodへの適用の前に待ち時間を置いたりすることは、この形ではできません。GitHubの環境（Environments）の機能が使える上位のプランであれば、こうした指定を、ワークフローの外の設定として持てます。ただし、本シリーズの検証環境は無料プランの非公開リポジトリのため、この機能は検証していません。

**記録そのものの保護。** 承認待ち（`~/gitops-pending/`）と`gitops.applied`は、制御ノードとPostgreSQLの上にあります。これらに直接書き込める人は、順序の確認を迂回できます。誰に、どこまでの権限を持たせるかは、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

---

[↑ 目次に戻る](#-目次)

---

## 6. クラウドでは接続先と認証情報が変わるだけ

この回の検証環境では、3つの環境を、1台の制御ノードの上のDockerのコンテナとネットワークで表しました。クラウドで複数の環境を持つときは、環境ごとにAWSのアカウントや、Google Cloudのプロジェクトを分ける構成がよく使われます。環境の入れ物が、Dockerのネットワークから、クラウドのアカウントやプロジェクトに変わります。

それでも、ここまでに作った構造は変わりません。そのことを、今の3つの環境のディレクトリで、何が違うかから確かめます。

#### ■ 検証内容：環境ごとのディレクトリで、違うものを確かめる

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git log --oneline -1
ls terraform/envs/dev terraform/envs/stg terraform/envs/prod
diff terraform/envs/dev/main.tf terraform/envs/stg/main.tf; echo "diff_exit_code=$?"
diff terraform/envs/stg/main.tf terraform/envs/prod/main.tf; echo "diff_exit_code=$?"
diff terraform/envs/dev/outputs.tf terraform/envs/prod/outputs.tf; echo "diff_exit_code=$?"
for e in dev stg prod; do echo "== $e"; ls -la ansible/inventories/$e; cat ansible/inventories/$e/group_vars/target_nodes.yml; done
```

**▼ 実行結果**

```plaintext
f000596 (HEAD -> main, origin/main) Merge pull request #56 from juehara-crypto/gitops10-replace-test
terraform/envs/dev:
main.tf  outputs.tf  terraform.tfvars

terraform/envs/prod:
main.tf  outputs.tf  terraform.tfvars

terraform/envs/stg:
main.tf  outputs.tf  terraform.tfvars
4c4
<     schema_name = "terraform_remote_state_dev"
---
>     schema_name = "terraform_remote_state_stg"
30c30
<     "dev-node1" = 2241
---
>     "stg-node1" = 2251
33,34c33,34
<   network_name          = "ansible-dev-net"
<   image_name            = "ansible-target:ubuntu22.04-dev"
---
>   network_name          = "ansible-stg-net"
>   image_name            = "ansible-target:ubuntu22.04-stg"
diff_exit_code=1
4c4
<     schema_name = "terraform_remote_state_stg"
---
>     schema_name = "terraform_remote_state"
25a26,30
> variable "deploy_user_password" {
>   type      = string
>   sensitive = true
> }
>
30c35,37
<     "stg-node1" = 2251
---
>     "target-node1" = 2231
>     "target-node2" = 2222
>     "target-node3" = 2223
33,34c40,41
<   network_name          = "ansible-stg-net"
<   image_name            = "ansible-target:ubuntu22.04-stg"
---
>   network_name          = "ansible-lab-net"
>   image_name            = "ansible-target:ubuntu22.04"
37a45,111
> }
>
> moved {
>   from = docker_image.ansible_target
>   to   = module.lab_env.docker_image.this
> }
（途中省略：残り3つのmovedブロック、どのコンテナも使っていない3つのイメージとネットワーク）
diff_exit_code=1
diff_exit_code=0
== dev
total 12
drwxrwxr-x 3 control control 4096 Oct 11 06:48 .
drwxrwxr-x 5 control control 4096 Oct 11 06:48 ..
drwxrwxr-x 2 control control 4096 Oct 11 06:48 group_vars
lrwxrwxrwx 1 control control   25 Oct 11 06:48 terraform_inventory.py -> ../terraform_inventory.py
---
common_setup_env: dev
== stg
（途中省略：devと同じ構成）
---
common_setup_env: stg
== prod
（途中省略：devと同じ構成）
---
common_setup_env: prod
```

#### ■ 結果

devとstgの`main.tf`の違いは、tfstateのスキーマ名、ノードの名前とポート、ネットワークの名前、イメージの名前だけです。どれも、共通のモジュールに渡す値か、tfstateの置き場所です。`outputs.tf`は、3つの環境で同じでした。各ディレクトリの`terraform.tfvars`は、手元のパスワードの変数ファイルで、**[セクション3](#3-tfstateを環境ごとに分ける)** で確かめたとおり、`.gitignore`の対象としてコミットには入っていません。

prodにだけある違いは、2種類です。1つは、prodの3台と、そのために使う`deploy_user_password`の変数です。もう1つは、セクション3で、作り直さずにモジュールへ移すために置いた`moved`ブロックと、どのコンテナも使っていないリソースです。後者は、prodが、環境を分ける前から動いていたことの名残で、環境の違いではありません。

Ansibleのインベントリのディレクトリは、どの環境も、同じスクリプトへのシンボリックリンクと、`group_vars`の1つの値だけです。

### クラウドで、環境ごとに変わるもの

この検証環境で、環境ごとに違っていたのは、次の2つでした。

* tfstateの置き場所（PostgreSQLのスキーマ）
* 共通のモジュールに渡す値（ノード、ネットワーク、イメージの名前など）

環境ごとにアカウントやプロジェクトを分けたクラウドでは、ここに、次の2つが加わります。

* プロバイダーの接続先。どのアカウントやプロジェクト、どのリージョンを操作するか
* 認証情報。その接続先を操作するための権限

接続先は、環境のディレクトリの`main.tf`に書く、プロバイダーの設定です。例えば、AWSで環境ごとにアカウントを分けるなら、各環境の`main.tf`で、その環境のアカウントのIAMロールを引き受けるように書きます。

**▼ AWSで、環境ごとにアカウントを分ける場合の`terraform/envs/prod/main.tf`の例（この回では検証していない）**

```hcl
provider "aws" {
  region = "ap-northeast-1"
  assume_role {
    role_arn = "arn:aws:iam::<prodのアカウントID>:role/<Terraformの実行に使うロール>"
  }
}
```

Google Cloudなら、`provider "google"`の`project`に、環境ごとのプロジェクトを書きます。どちらの場合も、書く場所は、この回で`schema_name`やノードの値を書いたのと同じ、環境のディレクトリです。共通のモジュールには、接続先を書きません。

一方で、次のものは、プロバイダーが何であっても変わりません。

* mainの1本と、環境ごとのディレクトリで分ける構造（**[セクション2](#2-ブランチで分けるかディレクトリで分けるか)**）
* 環境ごとのtfstateと、環境ごとのインベントリ（**[セクション3](#3-tfstateを環境ごとに分ける)**、**[セクション4](#4-インベントリと変数を環境ごとに分ける)**）
* 環境ごとの承認待ち、昇格の順序の確認、削除と作り直しの扱い（**[セクション5](#5-昇格の順序と条件をワークフローで強制する)**）

ワークフローは、選んだ環境の名前で、`terraform/envs/<環境>`と`inventories/<環境>`を決めているだけです。プロバイダーの接続先が変わっても、ワークフローの形は変わりません。

残るのは、認証情報をどう渡すかです。この検証環境では、3つの環境の操作に、同じ制御ノードの、同じDockerを使っています。クラウドでは、devの実行にprodの権限を渡さないように、環境ごとに別の認証情報を渡す必要があります。どの認証情報を、どこに置き、どの実行に渡すかは、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* 環境の分け方は、環境ごとのブランチではなく、mainの1本と環境ごとのディレクトリにした。ブランチで分けると、環境の間の差分が、コードの差分とマージの順序に混ざり、「唯一の真実」がブランチの数だけに分かれる。ディレクトリで分けると、どの環境も同じmainのコミットから作られ、環境ごとの違いは、同じコードに渡す値の違いとして残る
* tfstateは、環境ごとのディレクトリと、PostgreSQLの環境ごとのスキーマで分けた。Terraformのワークスペースで分ける方法は、どの環境を操作するかが、手元の`.terraform/environment`というコードの外の状態で決まり、初期化し直すと、何も言わずに`default`に戻ることを実機で確認した
* 既存のprodを共通のモジュールに移すときは、`moved`ブロックで、アドレスの付け替えだけにした。イメージの`build`の`context`の文字列を`.`から`./`に変えただけで、イメージとコンテナ3台の作り直しになることを確認し、`ignore_changes = [build]`で避けた。移した後も、prodのコンテナは1台も作り直されていない
* インベントリは、1つのスクリプトを`inventories/<環境>/`にシンボリックリンクで置き、置かれたディレクトリの名前で、読むtfstateと使う鍵を決める形にした。環境の名前として知らないディレクトリからは、エラーで終わる。環境ごとの値は、`inventories/<環境>/group_vars/`で、同じロールに渡す
* 鍵は環境ごとに分かれ、devの鍵ではprodのコンテナに入れない。ただし、Ansibleが既定で使う接続の再利用（`ControlPersist`）のため、prodに接続した直後は、devの鍵を指定しても接続に成功して見えることを実機で確認した。また、**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で`.gitignore`に加えた規則が、環境ごとの`group_vars`を、何も言わずにコミットから外していた
* 1回のマージで、dev・stg・prodの3つの承認待ちを作り、環境ごとの「最後に適用したコミット」を、tfstateと同じPostgreSQLの表（`gitops.applied`）に記録する形にした。変更の検出は、マージの直前のコミットではなく、各環境に最後に適用したコミットを基準にする。承認待ちが作られなかったマージの変更も、まだ適用していない変更として、次の判定に含まれることを確認した
* 「GitOps Apply」で適用する環境を選び、stgはdevに、prodはstgに、同じコミットを適用し終えるまで適用できないようにした。stgより先にprodを起動すると、順序の確認で止まった。プルリクエストを通ったかの確認は、その環境に最後に適用したコミットからの範囲で行うため、stgでは、stgに最後に適用した後に積み重なった2つのマージをまとめて確かめた
* 削除と作り直しは、同じplanの判定を、環境によって違う重さで扱う。devは警告を出して通し、stgとprodは`allow_destroy`を選ばない限り止めた。どの環境でも、適用されたplanのハッシュ値は、マージのときに保存したものと同じで、作り直したコンテナには、同じ実行の中でAnsibleが設定を置き直した
* 起動のときの選択欄が既定値の`dev`のまま、prodのつもりの起動が3回続けてdevで動いた。順序の確認があるため、選び間違いでstgやprodに先に適用されることはない。一方で、昇格の途中で新しいマージがあると、devからやり直しになること、誰がどの環境を承認できるかを分けられないことは、この形では守れない
* クラウドで環境ごとにアカウントやプロジェクトを分けても、変わるのは、プロバイダーの接続先と認証情報だけである。mainの1本と環境ごとのディレクトリ、環境ごとのtfstateとインベントリ、昇格の順序の確認は、プロバイダーを問わずそのまま使える

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

本シリーズの **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** までで、AnsibleとTerraformの両側に、人の承認の手前で機械的に止めるガードレールがそろいました。第10回となる今回は、その仕組みを、dev・stg・prodの3つの環境に広げました。環境をブランチではなく、mainの1本と環境ごとのディレクトリで分け、tfstate・インベントリ・鍵・変数を環境ごとに分けました。そのうえで、1回のマージから3つの承認待ちを作り、環境ごとに「最後に適用したコミット」を記録して、dev、stg、prodの順にしか適用できないことを、ワークフローで確かめる形にしました。削除と作り直しは、devでは通し、stgとprodでは人が明示して許可することを、実機で確認しました。

ここまでのパイプラインは、変更を前に進めることを扱ってきました。では、適用した変更が誤りだったとき、どう戻すのでしょうか。GitOpsでは、Gitの履歴を`git revert`で戻し、それを適用すれば、インフラも元に戻ると考えがちです。宣言型のTerraformは、コードを戻せば、それに合わせて状態も戻ります。一方、手続き型のAnsibleは、タスクを消しても、一度入れた設定は、対象のサーバーに残ったままです。

**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** では、この複数環境のパイプラインで`git revert`によるロールバックを行い、TerraformとAnsibleで戻り方が異なる非対称性を、実機で確認します。GitOpsのロールバックを、元に戻すのではなく、戻す変更を前に進める「ロールフォワード」として整理し、revertの残骸が、これまでの仕組みでは検知できないことを示します。

**[次回：第11回：git revertしてもOSは戻らない：ロールバックの非対称性](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)　｜　[次の記事：【GitOps編】第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第2部まとめブログ：GitOpsパイプラインで「見たものだけが、承認したときだけ届く」仕組みを積み上げる** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「Ansible×TerraformをGitOpsで回す」

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