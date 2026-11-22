---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第15回：複数人が別々のディレクトリでterraform applyしたtfstateを上書きすると記録が消え、出力名の変更だけでAnsibleのスクリプトも止まる理由―state lockingの守備範囲と、中間ファイルによる分離'
description: '複数人が別々の作業ディレクトリでapplyしたtfstateを、後から片方で上書きすると、先発の変更記録が消えることを実機で確認する。あわせて、state lockingが防ぐのは同一ディレクトリ内の同時実行であること、Ansible担当がtfstateを直接参照すると出力名の変更だけでスクリプトが止まること、terraform output -jsonの中間ファイルで影響を切り離せることを整理する。'
pubDate: '2026-08-20'
category: 'infra'
tags: ['Ansible', 'Terraform', 'tfstate', 'state locking', 'チーム運用']
seriesId: 'ansible-terraform-part2'
seriesNo: 15
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題](https://qiita.com/juehara-crypto/items/c3e95e3bec11e07bbe75)**

---

> **🔍 今起きている症状・課題から、読むべき回を探したい方はこちら**
>
> 全50回で扱った症状・課題を、部をまたいで1か所に集めた逆引きリファレンスがあります。
> 症状・課題の一覧から原因の見当をつけ、該当する回のセクションまでたどれます。
>
> → **[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」逆引きリファレンス：全50回の症状・課題を5つの図から引く](https://qiita.com/juehara-crypto/items/bd2832993ef887e8022a)**

---

**※本記事の位置とシリーズ全体の関係を先に確認します。**

---

## 📍 本記事の位置

````mermaid
graph TD
    Main["統合ブログ<br/>シリーズ全体のナビゲーション"]

    subgraph Parts [各部のまとめブログ　全5本]
        Part1["第1部まとめブログ<br/>環境構築、連携編"]
        Part2["第2部まとめブログ<br/>運用、ライフサイクル編"]
        Part3["第3部まとめブログ<br/>トラブルシューティング、デバッグ編"]
        Part4["第4部まとめブログ<br/>改善、CI/CD自動化編"]
        Part5["第5部まとめブログ<br/>Terraformライフサイクル破壊編"]
    end

    subgraph Articles [各回ブログ　全50本]
        Part1_Detail["第1回〜第10回"]
        Part2_Detail["第11回〜第20回"]
        Part3_Detail["第21回〜第30回"]
        Part4_Detail["第31回〜第40回"]
        Part5_Detail["第41回〜第50回"]
    end

    Reverse["逆引きリファレンス<br/>全50回の症状・課題を集約"]

    Main --- Part1
    Main --- Part2
    Main --- Part3
    Main --- Part4
    Main --- Part5

    Part1 --- Part1_Detail
    Part2 --- Part2_Detail
    Part3 --- Part3_Detail
    Part4 --- Part4_Detail
    Part5 --- Part5_Detail

    Part1_Detail --- Reverse
    Part2_Detail --- Reverse
    Part3_Detail --- Reverse
    Part4_Detail --- Reverse
    Part5_Detail --- Reverse

    style Main fill:#e1f5fe,stroke:#01579b,stroke-width:3px
    style Part2_Detail fill:#fff3e0,stroke:#e65100,stroke-width:3px
    style Parts fill:none
    style Articles fill:none
````

本シリーズは、**[統合ブログ](https://qiita.com/juehara-crypto/items/5bd6720b7aaed13757f8)**、第1〜5部のまとめブログ（全5本）、第1〜50回の各回ブログ（全50本）の3階層で構成されています。**現在はこの図の下段、第2部「第11回〜第20回」のうちの第15回になります。** 統合ブログとまとめブログは、シリーズを上から順に読み進めるための入口です。

また、この3階層とは別に、**[逆引きリファレンス](https://qiita.com/juehara-crypto/items/bd2832993ef887e8022a)** があります。第1〜50回の各回ブログで扱った症状・課題を、部をまたいで1か所に集め、今起きている症状や解決したい課題から、該当する回へ直接たどり着けるようにしたものです。

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [tfstateがローカルファイルの場合の競合](#2-tfstateがローカルファイルの場合の競合)
3. [リモートバックエンドとstate lockingによる競合防止](#3-リモートバックエンドとstate-lockingによる競合防止)
4. [Terraform担当とAnsible担当の境界が曖昧になるリスク](#4-terraform担当とansible担当の境界が曖昧になるリスク)
5. [役割分担の設計パターン](#5-役割分担の設計パターン)
6. [チーム運用におけるapply実行権限の設計](#6-チーム運用におけるapply実行権限の設計)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「`terraform apply`を実行したら、自分が追加したはずのリソースの記録が消えていた」という経験はないでしょうか。

**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)** では、`local-exec`経由でAnsibleが複数回実行される構成において、冪等性が確保されていないPlaybookが`terraform apply`自体の失敗につながる構造を整理しました。この回まで、検証は一貫して1人がTerraformとAnsibleの両方を操作する前提で進めてきました。

しかし、実際の運用ではこの前提が成立しない場面があります。

* Terraformを管理するエンジニアと、Ansibleを実行するオペレーターが別のチームに分かれている
* 同じ`main.tf`に対して、複数人がそれぞれの作業ディレクトリから`terraform apply`を実行できる状態になっている
* Ansible側のインベントリが、Terraformのtfstateから直接値を読み取る構成になっている

こうした体制で起きるのが、「複数人がそれぞれの作業ディレクトリから`terraform apply`を実行し、後からtfstateが上書きされたら、片方の変更の記録が消えた」という事象です。

正確に言うと、**tfstateはローカルファイル、または共有バックエンドで管理される単一の状態ファイルです。同一ディレクトリ内の同時実行はローカルバックエンドでもロックされますが、作業ディレクトリが分かれたり、tfstateがコピーされたりすると、この保護は働きません。その範囲の保護は運用設計に委ねられています**。この前提を踏まえずに複数人がそれぞれtfstateを扱うと、一方の記録がもう一方によって上書きされる、あるいは意図しない形で失われることがあります。

この回では、視点を単一環境から複数人での運用に移し、tfstateという共有リソースを複数人が扱うことで生じる競合の構造を整理します。そのうえで、Terraform担当とAnsible担当という役割分担をどう設計すれば、この競合を防げるかを見ていきます。

まず次のセクションで、tfstateがローカルファイルとして管理されている場合に、この競合が実際にどう起きるかを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. tfstateがローカルファイルの場合の競合

tfstateがローカルファイルとして管理されている場合に起きる競合の構造を整理します。

まず、tfstateをGitで管理する運用がアンチパターンである理由を確認します。

* tfstateには、生成したリソースの属性値がそのまま記録されます。実務環境ではデータベースのパスワードやAPIキーなどが平文で含まれることが多く、Git管理はそのまま漏洩リスクになります
* tfstateはJSON形式のファイルですが、Gitのマージ機構はこのJSONを構造として理解した上でマージするわけではありません。単純なテキスト差分としてコンフリクトを検出するにとどまり、複数人が同時に変更した場合、機械的な解決が困難な競合を引き起こします

こうした理由から、tfstateをGit管理下に置く運用は推奨されません。しかし、ローカルファイルでの運用が残っている現場では、「誰か一人だけがapplyする」という暗黙のルールで運用を回避しているケースが少なくありません。ここで明確にしておきたいのは、これは技術的な排他制御ではなく、運用文化に依存した回避策に過ぎないという点です。ルールを知らない、あるいは守らない人が一人でもいれば、この回避策は機能しなくなります。

この構造を、実機で確認します。

### ■ 検証内容（ローカルtfstateに対して2人の作業者がそれぞれ変更を加え、後発側のtfstateが先発側の変更を含まない状態で上書きされることの確認）

本検証環境の作業ディレクトリ`~/iac/docker-lab`を`~/iac/docker-lab-copy`に複製し、2人の独立した作業者（作業者A、作業者B）を模した状態を作ります。

**実行コマンド**

````plaintext
cp -r ~/iac/docker-lab ~/iac/docker-lab-copy
````

複製後、両ディレクトリはそれぞれ独立したtfstateを持ちます。ここに、それぞれの作業者が加えた変更として、コンテナ操作を伴わない軽量なリソースを追加します。

作業者A（`~/iac/docker-lab`）の`main.tf`に、以下を追加します。

* **ファイル名：**`main.tf`（`~/iac/docker-lab`、追記部分）

````hcl
resource "local_file" "conflict_demo_a" {
  filename = "${path.module}/conflict_demo_a.txt"
  content  = "added by workspace A\n"
}
````

作業者Aの変更を`apply`します。

**実行コマンド**
````plaintext
terraform plan
````

**▼ 実行結果**
````plaintext
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
null_resource.mkdir_idempotency_demo: Refreshing state... [id=1355779908856997373]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node1"]: Refreshing state... [id=2dacb702c37e4ef0af967e2a09467936cd99653d2b9223042600fe3d522e867f]
docker_container.targets["target-node3"]: Refreshing state... [id=c0bf3acaad8594c22759d078da57ecea563acd09c383d5c0cd8e8eabb32ba1ea]
docker_container.targets["target-node2"]: Refreshing state... [id=76222e1321ba17684ec09adf7142f25a12867550cf81834fc583575244a14b12]
local_file.ansible_inventory: Refreshing state... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
null_resource.provision: Refreshing state... [id=4730705910091877190]
Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create
  - destroy

Terraform will perform the following actions:

  # local_file.conflict_demo_a will be created
  + resource "local_file" "conflict_demo_a" {
      + content              = <<-EOT
            added by workspace A
        EOT
      + content_base64sha256 = (known after apply)
      + content_base64sha512 = (known after apply)
      + content_md5          = (known after apply)
      + content_sha1         = (known after apply)
      + content_sha256       = (known after apply)
      + content_sha512       = (known after apply)
      + directory_permission = "0777"
      + file_permission      = "0777"
      + filename             = "./conflict_demo_a.txt"
      + id                   = (known after apply)
    }

  # null_resource.mkdir_idempotency_demo will be destroyed
  # (because null_resource.mkdir_idempotency_demo is not in configuration)
  - resource "null_resource" "mkdir_idempotency_demo" {
      - id       = "1355779908856997373" -> null
      - triggers = {
          - "demo_version" = "v2"
        } -> null
    }

Plan: 1 to add, 0 to change, 1 to destroy.
````

**実行コマンド**
````plaintext
terraform apply
````

**▼ 実行結果**
````plaintext
（…途中省略、plan結果と同一内容…）

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.mkdir_idempotency_demo: Destroying... [id=1355779908856997373]
null_resource.mkdir_idempotency_demo: Destruction complete after 0s
local_file.conflict_demo_a: Creating...
local_file.conflict_demo_a: Creation complete after 0s [id=bdb58323700b763000aa72f893739c1cdf9d7a08]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.20.0.4"
  "target-node2" = "172.20.0.3"
  "target-node3" = "172.20.0.2"
}
````

なお、`null_resource.mkdir_idempotency_demo`の破棄は、第14回の検証用に追加したリソースを`main.tf`から外したことによるもので、この回の検証とは関係ありません。作業者Bの`plan`、`apply`に出る同じ破棄も、同じ理由です。

続いて、作業者B（`~/iac/docker-lab-copy`）の`main.tf`に、以下を追加します。

* **ファイル名：**`main.tf`（`~/iac/docker-lab-copy`、追記部分）
````hcl
resource "local_file" "conflict_demo_b" {
  filename = "${path.module}/conflict_demo_b.txt"
  content  = "added by workspace B\n"
}
````

ここで重要なのは、作業者Bが参照している`~/iac/docker-lab-copy`のtfstateは、複製した時点、つまり作業者Aの変更より前のtfstateのままだという点です。作業者Bはこの状態のまま、自分の変更を`apply`します。

**実行コマンド**
````plaintext
terraform plan
````

**▼ 実行結果**

````plaintext
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
null_resource.mkdir_idempotency_demo: Refreshing state... [id=1355779908856997373]
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node2"]: Refreshing state... [id=76222e1321ba17684ec09adf7142f25a12867550cf81834fc583575244a14b12]
docker_container.targets["target-node3"]: Refreshing state... [id=c0bf3acaad8594c22759d078da57ecea563acd09c383d5c0cd8e8eabb32ba1ea]
docker_container.targets["target-node1"]: Refreshing state... [id=2dacb702c37e4ef0af967e2a09467936cd99653d2b9223042600fe3d522e867f]
local_file.ansible_inventory: Refreshing state... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
null_resource.provision: Refreshing state... [id=4730705910091877190]
Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create
  - destroy

Terraform will perform the following actions:

  # local_file.conflict_demo_b will be created
  + resource "local_file" "conflict_demo_b" {
      + content              = <<-EOT
            added by workspace B
        EOT
      + content_base64sha256 = (known after apply)
      + content_base64sha512 = (known after apply)
      + content_md5          = (known after apply)
      + content_sha1         = (known after apply)
      + content_sha256       = (known after apply)
      + content_sha512       = (known after apply)
      + directory_permission = "0777"
      + file_permission      = "0777"
      + filename             = "./conflict_demo_b.txt"
      + id                   = (known after apply)
    }

  # null_resource.mkdir_idempotency_demo will be destroyed
  # (because null_resource.mkdir_idempotency_demo is not in configuration)
  - resource "null_resource" "mkdir_idempotency_demo" {
      - id       = "1355779908856997373" -> null
      - triggers = {
          - "demo_version" = "v2"
        } -> null
    }

Plan: 1 to add, 0 to change, 1 to destroy.
````

**実行コマンド**

````plaintext
terraform apply
````

**▼ 実行結果**
````plaintext
（…途中省略、plan結果と同一内容…）

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.mkdir_idempotency_demo: Destroying... [id=1355779908856997373]
null_resource.mkdir_idempotency_demo: Destruction complete after 0s
local_file.conflict_demo_b: Creating...
local_file.conflict_demo_b: Creation complete after 0s [id=54aa0ed3fefb88719f37bef2ff61b2bf8bf38905]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.20.0.4"
  "target-node2" = "172.20.0.3"
  "target-node3" = "172.20.0.2"
}
````

この時点で、両ディレクトリのtfstateがそれぞれ何を記録しているかを確認します。

**実行コマンド**
````plaintext
terraform state list
````

**▼ 実行結果（`~/iac/docker-lab-copy`）**
````plaintext
docker_container.targets["target-node1"]
docker_container.targets["target-node2"]
docker_container.targets["target-node3"]
docker_image.ansible_target
docker_image.ansible_target_deploy_nopasswd
docker_image.ansible_target_deploy_passwd
docker_image.ansible_target_legacy
docker_network.lab_net
local_file.ansible_inventory
local_file.conflict_demo_b
local_file.private_key
null_resource.fix_permission
null_resource.provision
tls_private_key.generated
````

**実行コマンド**
````plaintext
cd ~/iac/docker-lab
terraform state list
````

**▼ 実行結果（`~/iac/docker-lab`）**
````plaintext
docker_container.targets["target-node1"]
docker_container.targets["target-node2"]
docker_container.targets["target-node3"]
docker_image.ansible_target
docker_image.ansible_target_deploy_nopasswd
docker_image.ansible_target_deploy_passwd
docker_image.ansible_target_legacy
docker_network.lab_net
local_file.ansible_inventory
local_file.conflict_demo_a
local_file.private_key
null_resource.fix_permission
null_resource.provision
tls_private_key.generated
````

この時点では、2つのディレクトリはそれぞれ別々のtfstateファイルとして独立して存在しているため、作業者Aのtfstateには`conflict_demo_a`が、作業者Bのtfstateには`conflict_demo_b`が、互いに見えない状態でそれぞれ記録されています。ここからさらに一歩進め、後発側（作業者B）のtfstateが、先発側（作業者A）のtfstateファイルを物理的に上書きした場合を再現します。

**実行コマンド**
````plaintext
cp ~/iac/docker-lab-copy/terraform.tfstate ~/iac/docker-lab/terraform.tfstate
````

上書き後、`~/iac/docker-lab`側で再度`state list`を確認します。

**実行コマンド**
````plaintext
terraform state list
````

**▼ 実行結果**
````plaintext
docker_container.targets["target-node1"]
docker_container.targets["target-node2"]
docker_container.targets["target-node3"]
docker_image.ansible_target
docker_image.ansible_target_deploy_nopasswd
docker_image.ansible_target_deploy_passwd
docker_image.ansible_target_legacy
docker_network.lab_net
local_file.ansible_inventory
local_file.conflict_demo_b
local_file.private_key
null_resource.fix_permission
null_resource.provision
tls_private_key.generated
````

`~/iac/docker-lab`のtfstateから、作業者Aが追加したはずの`local_file.conflict_demo_a`が消え、代わりに作業者Bの`local_file.conflict_demo_b`が記録されています。

ここで、tfstateから消えたことと、実体（このケースではファイル）が消えたことが同じ意味かどうかを確認します。

**実行コマンド**
````plaintext
ls ~/iac/docker-lab/conflict_demo_a.txt ~/iac/docker-lab/conflict_demo_b.txt
````

**▼ 実行結果**
````plaintext
ls: cannot access '/home/control/iac/docker-lab/conflict_demo_b.txt': No such file or directory
/home/control/iac/docker-lab/conflict_demo_a.txt
````

`conflict_demo_a.txt`は実体として`~/iac/docker-lab`に残っています。tfstateの上書きによって消えたのはあくまでtfstate上の記録であり、Terraformが実際にファイルを削除したわけではありません。

一方で、tfstateが記録している`local_file.conflict_demo_b`の実体は`~/iac/docker-lab`には存在しません。

**実行コマンド**
````plaintext
ls ~/iac/docker-lab-copy/conflict_demo_b.txt
````

**▼ 実行結果**
````plaintext
/home/control/iac/docker-lab-copy/conflict_demo_b.txt
````

実体は、作業者Bが実際に`apply`した`~/iac/docker-lab-copy`側に存在しています。`local_file`リソースの`filename`は`path.module`（HCLコードが置かれているディレクトリ）を基準とした相対パスで解決されるため、tfstateだけを別のディレクトリへコピーしても、そのtfstateが指すリソースの実体までは移動しません。

### ■ 結果

この検証から、2つのことが確認できました。

1つ目は、当初想定していた通りの結果です。ローカルのtfstateに対して2人の作業者がそれぞれ独立に変更を加え、後発側のtfstateファイルで先発側のtfstateファイルを上書きすると、先発側の変更記録はtfstate上から失われます。tfstateはリソースの一覧を丸ごと保持する単一のファイルであり、差分だけをマージする仕組みを持っていません。上書きは常に「まるごと置き換え」になります。

2つ目は、検証の過程で追加で確認できた点です。tfstateから消えることと、リソースの実体が消えることは同じではありません。`conflict_demo_a.txt`はファイルとして残り続けていました。逆に、上書き後のtfstateが記録している`local_file.conflict_demo_b`は、そのtfstateを持つディレクトリには実体が存在せず、実際の実体は別のディレクトリに残っていました。tfstateはリソースの「状態の記録」であり、実体そのものではありません。tfstateだけを共有、あるいは上書きする操作は、その記録が指し示すリソースの実体がどこにあるかという対応関係そのものをズレさせる可能性があります。

いずれの結果も、作業ディレクトリが分かれ、tfstateがそれぞれ独立して存在する場合、Terraform自体にはその間の整合性を保つ仕組みが備わっていないことを示しています。次のセクションでは、この問題を技術的に防ぐ仕組みであるリモートバックエンドとstate lockingを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. リモートバックエンドとstate lockingによる競合防止

リモートバックエンドによる技術的な競合防止の仕組みを整理します。

リモートバックエンドの多くは、state lockingという機能を提供します。ロックの方式や対応状況はバックエンドごとに異なります。`apply`実行時にロックを取得し、他の実行はそのロックが解除されるまで待機、またはエラーで弾かれる仕組みです。実は、本検証環境で使っているローカルバックエンド（`terraform.tfstate`をローカルファイルとして扱う構成）にも、同一ディレクトリ内での同時実行に対しては、この基本的なロック機構が備わっています。この回の実機確認は、このローカルバックエンドのロックを対象にしています。

処理に時間のかかる操作を意図的に再現するため、`hashicorp/time`プロバイダーの`time_sleep`リソースを用意しました。

* **ファイル名：**`main.tf`（追記部分）

````hcl
terraform {
  required_providers {
    # (既存のprovider定義に追加)
    time = {
      source  = "hashicorp/time"
      version = "~> 0.11"
    }
  }
}

resource "time_sleep" "lock_demo" {
  create_duration = "60s"
}
````

`time_sleep`は`create_duration`で指定した時間だけ、実際に`apply`の処理を待機させるリソースです。インフラには一切影響しませんが、`apply`の処理時間を意図的に引き延ばすことができます。

### ■ 検証内容（同一ディレクトリに対する`terraform apply`の実行中に、別プロセスからの操作がstate lockingによって弾かれることの確認）

ターミナルを2つ用意し、片方（ターミナル1）で`apply`を実行している最中に、もう片方（ターミナル2）から同じディレクトリに対して`terraform plan`を実行します。

**実行コマンド（ターミナル1）**

````plaintext
terraform apply
````

**▼ 実行結果（ターミナル1）**

````plaintext
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node1"]: Refreshing state... [id=2dacb702c37e4ef0af967e2a09467936cd99653d2b9223042600fe3d522e867f]
docker_container.targets["target-node2"]: Refreshing state... [id=76222e1321ba17684ec09adf7142f25a12867550cf81834fc583575244a14b12]
docker_container.targets["target-node3"]: Refreshing state... [id=c0bf3acaad8594c22759d078da57ecea563acd09c383d5c0cd8e8eabb32ba1ea]
local_file.ansible_inventory: Refreshing state... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
null_resource.provision: Refreshing state... [id=4730705910091877190]
Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # time_sleep.lock_demo will be created
  + resource "time_sleep" "lock_demo" {
      + create_duration = "60s"
      + id              = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

time_sleep.lock_demo: Creating...
time_sleep.lock_demo: Still creating... [00m11s elapsed]
time_sleep.lock_demo: Still creating... [00m21s elapsed]
time_sleep.lock_demo: Still creating... [00m31s elapsed]
time_sleep.lock_demo: Still creating... [00m41s elapsed]
time_sleep.lock_demo: Still creating... [00m51s elapsed]
time_sleep.lock_demo: Creation complete after 1m1s [id=2026-08-20T13:19:01Z]

Apply complete! Resources: 1 added, 0 changed, 0 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.20.0.4"
  "target-node2" = "172.20.0.3"
  "target-node3" = "172.20.0.2"
}
````

ターミナル1の`apply`が実行中の間（`Still creating...`が表示されている間）に、ターミナル2で同じディレクトリに対して`plan`を実行します。

**実行コマンド（ターミナル2）**

````plaintext
terraform plan
````

**▼ 実行結果（ターミナル2）**

````plaintext
╷
│ Error: Error acquiring the state lock
│
│ Error message: resource temporarily unavailable
│ Lock Info:
│   ID:        3b4ec9e0-9583-f299-f9d4-76afc3733616
│   Path:      terraform.tfstate
│   Operation: OperationTypeApply
│   Who:       control@ubuntu-controller
│   Version:   1.15.7
│   Created:   2026-08-20 13:17:29.993044063 +0000 UTC
│   Info:
│
│
│ Terraform acquires a state lock to protect the state from being written
│ by multiple users at the same time. Please resolve the issue above and try
│ again. For most commands, you can disable locking with the "-lock=false"
│ flag, but this is not recommended.
╵
````

ターミナル2の`plan`は、`Error acquiring the state lock`というエラーで即座に弾かれました。エラーメッセージには、ロックを保持しているのが誰か（`Who`）、どの操作か（`Operation`）、いつ取得されたか（`Created`）が明示されています。

ターミナル1の`apply`が完了した後、ターミナル1で改めて`plan`を実行し、ロックが解放されていることを確認します。

**実行コマンド（ターミナル1側、apply完了後の確認）**

````plaintext
terraform plan
````

**▼ 実行結果**

````plaintext
time_sleep.lock_demo: Refreshing state... [id=2026-08-20T13:19:01Z]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node3"]: Refreshing state... [id=c0bf3acaad8594c22759d078da57ecea563acd09c383d5c0cd8e8eabb32ba1ea]
docker_container.targets["target-node1"]: Refreshing state... [id=2dacb702c37e4ef0af967e2a09467936cd99653d2b9223042600fe3d522e867f]
docker_container.targets["target-node2"]: Refreshing state... [id=76222e1321ba17684ec09adf7142f25a12867550cf81834fc583575244a14b12]
local_file.ansible_inventory: Refreshing state... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
null_resource.provision: Refreshing state... [id=4730705910091877190]
No changes. Your infrastructure matches the configuration.
Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
````

ロックエラーは発生せず、正常に完了しています。

state lockingがあっても起きる運用上の競合にも触れておきます。

* ロックを取得できず弾かれた側が、そのままエラーメッセージを読み流し、後で重複して同じ作業をやり直してしまう人的なミス
* 異常終了（Ctrl+Cによる中断、SSHセッションの切断など）によってロックが残り続け、次に`apply`しようとした人が同じ`Error acquiring the state lock`に直面し、原因も分からないまま操作できなくなる詰まり

後者が発生した場合、ロックを保持しているプロセスが実際には動いていないことを確認した上で、以下のコマンドで明示的に解除します。

````plaintext
terraform force-unlock <LOCK_ID>
````

`<LOCK_ID>`には、エラーメッセージの`ID`欄に表示された値（今回の例であれば`3b4ec9e0-9583-f299-f9d4-76afc3733616`）を指定します。ロックファイルを直接削除するのではなく、このコマンドを使うことが推奨されます。

### ■ 結果

state lockingにより、同一ディレクトリのtfstateに対する同時操作は、片方が実行中である限り、もう片方が確実にエラーで弾かれることが確認できました。セクション2で確認した「別ディレクトリにコピーしたtfstateには保護が及ばない」という状況と異なり、この場合は後発側の操作がそもそも実行されず、tfstateが上書きされることもありません。

ただし、ここで押さえておきたいのは、state lockingが防いでいるのはあくまで「同時書き込みによるtfstateの破損、上書き」という技術的な問題であるという点です。ロックで弾かれた人が、その後どう行動するか、つまり「後で自分の変更を安全に反映させる」という運用上の判断そのものは、ロック機構の範囲外にあります。ロックエラーを読み流してそのまま重複作業をしてしまう、あるいは異常終了でロックが残ったまま誰も触れなくなる、といった問題は、技術的な排他制御だけでは防げません。

技術的な排他制御（lock）と運用ルール（誰がいつ`apply`するか、ロックエラーが出たときにどう対応するか）は別の問題であり、両方が揃って初めて、tfstateの競合は実質的に防げるようになります。

---

[↑ 目次に戻る](#-目次)

---

## 4. Terraform担当とAnsible担当の境界が曖昧になるリスク

役割分担が曖昧な場合に起きる、セクション2、3とは別種の問題を整理します。

Ansible担当がインベントリ用にtfstateの出力値（IPアドレス等）を直接参照する運用を想定します。この場合、Terraform担当がtfstateの構造（リソース名、出力値の形式）を変更すると、Ansible側のインベントリ取得処理が予告なく壊れる可能性があります。この構造を実機で確認します。

### ■ 検証内容（tfstateを直接参照するスクリプトが、Terraform側の些細な変更によって壊れることの確認）

まず、Ansible担当がtfstateを直接参照する状況を模して、`output`を1つ追加します。

* **ファイル名：**`main.tf`（追記部分）

````hcl
output "target_node1_ip_direct" {
  value = docker_container.targets["target-node1"].network_data[0].ip_address
}
````

続けて、この`output`をtfstateのJSONから直接パースするスクリプトを用意します。tfstateを直接参照する、Ansible担当が書いたインベントリ取得スクリプトという想定です。

* **ファイル名：**`read_state_direct.py`

````python
#!/usr/bin/env python3
import json

with open("terraform.tfstate") as f:
    state = json.load(f)

print(state["outputs"]["target_node1_ip_direct"]["value"])
````

`output`を反映させます。

**実行コマンド**

````plaintext
terraform apply
````

**▼ 実行結果**

````plaintext
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node3"]: Refreshing state... [id=c0bf3acaad8594c22759d078da57ecea563acd09c383d5c0cd8e8eabb32ba1ea]
docker_container.targets["target-node2"]: Refreshing state... [id=76222e1321ba17684ec09adf7142f25a12867550cf81834fc583575244a14b12]
docker_container.targets["target-node1"]: Refreshing state... [id=2dacb702c37e4ef0af967e2a09467936cd99653d2b9223042600fe3d522e867f]
local_file.ansible_inventory: Refreshing state... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
null_resource.provision: Refreshing state... [id=4730705910091877190]
No changes. Your infrastructure matches the configuration.
Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

Outputs:

target_node1_ip_direct = "172.20.0.4"
target_nodes_ips = {
  "target-node1" = "172.20.0.4"
  "target-node2" = "172.20.0.3"
  "target-node3" = "172.20.0.2"
}
````

このログでは「No changes」と表示され、`Outputs`には`target_node1_ip_direct`が出ています。これは、このログの時点で、`output`の追加がすでにtfstateに反映されていたためです。`output`だけを追加した直後の`apply`では、「Changes to Outputs」に追加した出力が表示されます（セクション5で同じ`output`を追加し直したときのログを参照してください）。

スクリプトが正常に値を取得できることを確認します。

**実行コマンド**

````plaintext
python3 read_state_direct.py
````

**▼ 実行結果**

````plaintext
172.20.0.4
````

スクリプトが正しくIPアドレスを取得できました。この状態を起点に、Terraform担当側の視点で、些細なつもりの変更を加えます。`output`の名前を、値の中身は変えずに変更するだけです。

* **ファイル名：**`main.tf`（変更部分）

````hcl
output "node1_ip" {
  value = docker_container.targets["target-node1"].network_data[0].ip_address
}
````

**実行コマンド**

````plaintext
terraform plan
````

**▼ 実行結果**

````plaintext
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node2"]: Refreshing state... [id=76222e1321ba17684ec09adf7142f25a12867550cf81834fc583575244a14b12]
docker_container.targets["target-node1"]: Refreshing state... [id=2dacb702c37e4ef0af967e2a09467936cd99653d2b9223042600fe3d522e867f]
docker_container.targets["target-node3"]: Refreshing state... [id=c0bf3acaad8594c22759d078da57ecea563acd09c383d5c0cd8e8eabb32ba1ea]
local_file.ansible_inventory: Refreshing state... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
null_resource.provision: Refreshing state... [id=4730705910091877190]

Changes to Outputs:
  + node1_ip               = "172.20.0.4"
  - target_node1_ip_direct = "172.20.0.4" -> null

You can apply this plan to save these new output values to the Terraform state, without changing any real infrastructure.
````

`without changing any real infrastructure`と明示されている通り、実インフラには一切変更がありません。Terraform担当からすれば、単なる出力名のリファクタリングに過ぎない変更です。

**実行コマンド**

````plaintext
terraform apply
````

**▼ 実行結果**

````plaintext
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node1"]: Refreshing state... [id=2dacb702c37e4ef0af967e2a09467936cd99653d2b9223042600fe3d522e867f]
docker_container.targets["target-node2"]: Refreshing state... [id=76222e1321ba17684ec09adf7142f25a12867550cf81834fc583575244a14b12]
docker_container.targets["target-node3"]: Refreshing state... [id=c0bf3acaad8594c22759d078da57ecea563acd09c383d5c0cd8e8eabb32ba1ea]
local_file.ansible_inventory: Refreshing state... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
null_resource.provision: Refreshing state... [id=4730705910091877190]

Changes to Outputs:
  + node1_ip               = "172.20.0.4"
  - target_node1_ip_direct = "172.20.0.4" -> null

You can apply this plan to save these new output values to the Terraform state, without changing any real infrastructure.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

Outputs:

node1_ip = "172.20.0.4"
target_nodes_ips = {
  "target-node1" = "172.20.0.4"
  "target-node2" = "172.20.0.3"
  "target-node3" = "172.20.0.2"
}
````

この状態で、Ansible担当側のスクリプト（コード自体は一切変更していません）を再度実行します。

**実行コマンド**

````plaintext
python3 read_state_direct.py
````

**▼ 実行結果**

````plaintext
Traceback (most recent call last):
  File "/home/control/iac/docker-lab/read_state_direct.py", line 7, in <module>
    print(state["outputs"]["target_node1_ip_direct"]["value"])
KeyError: 'target_node1_ip_direct'
````

`KeyError`で例外が発生し、スクリプトが停止しました。

### ■ 結果

Terraform担当が行ったのは、実インフラに一切影響を与えない、出力名のリファクタリングだけでした。`terraform apply`のログにも「実インフラへの変更はない」と明示されており、Terraform担当の視点では、何かを壊したという自覚を持ちにくい変更です。

しかし、tfstateを直接参照していたAnsible担当のスクリプトは、この変更によって`KeyError`で停止しました。スクリプト側のコードは一切変更していません。参照先であるtfstateの構造が変わったことだけが原因です。

ここで確認しておきたいのは、この失敗がAnsible担当のミスではないという点です。スクリプトは、以前と同じ場所を同じように参照し続けているだけです。壊れた原因は、Terraform担当が「自分の作業範囲」だと思っている変更が、実は「Ansible担当の作業の前提」でもあったことに、双方が気づいていなかったことにあります。

tfstateを直接参照する設計は、この2つの担当の作業を、意図しない形で密結合させます。Terraform担当は、自分の変更がAnsible側に影響することを知らないまま変更を加え、Ansible担当は、自分のスクリプトが突然動かなくなった原因が、担当外のはずのTerraform側の変更にあることに、すぐには気づけません。この結合度の高さが、チーム運用における境界の曖昧さの正体です。

次のセクションでは、この結合度を下げる設計パターンを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. 役割分担の設計パターン

セクション4で示した結合度の高さを解消する設計パターンを整理します。

Terraform担当がtfstateの出力値を中間ファイル（JSON等）にエクスポートし、Ansible担当はそのファイルのみを参照する構成を実機で確認します。

### ■ 検証内容（中間ファイル経由の参照が、Terraform側の出力名変更に対して即座には影響を受けないことの確認）

セクション4の最後の状態では、tfstateに`node1_ip`が残っています。セクション4と同じ状況を再現するため、まず`main.tf`から`output "node1_ip"`のブロックを削除して`terraform apply`を実行し、その後に同じ`output`を再度追加します。

**実行コマンド**

````plaintext
terraform apply
````

**▼ 実行結果**

````plaintext
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node1"]: Refreshing state... [id=2dacb702c37e4ef0af967e2a09467936cd99653d2b9223042600fe3d522e867f]
docker_container.targets["target-node2"]: Refreshing state... [id=76222e1321ba17684ec09adf7142f25a12867550cf81834fc583575244a14b12]
docker_container.targets["target-node3"]: Refreshing state... [id=c0bf3acaad8594c22759d078da57ecea563acd09c383d5c0cd8e8eabb32ba1ea]
local_file.ansible_inventory: Refreshing state... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
null_resource.provision: Refreshing state... [id=4730705910091877190]

Changes to Outputs:
  - node1_ip         = "172.20.0.4" -> null

You can apply this plan to save these new output values to the Terraform state, without changing any real infrastructure.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes


Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.20.0.4"
  "target-node2" = "172.20.0.3"
  "target-node3" = "172.20.0.2"
}
````

続けて、セクション4と同じ`output`を再度追加します。

* **ファイル名：**`main.tf`（追記部分）
````hcl
output "target_node1_ip_direct" {
  value = docker_container.targets["target-node1"].network_data[0].ip_address
}
````

**実行コマンド**
````plaintext
terraform apply
````

**▼ 実行結果**
````plaintext
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node3"]: Refreshing state... [id=c0bf3acaad8594c22759d078da57ecea563acd09c383d5c0cd8e8eabb32ba1ea]
docker_container.targets["target-node1"]: Refreshing state... [id=2dacb702c37e4ef0af967e2a09467936cd99653d2b9223042600fe3d522e867f]
docker_container.targets["target-node2"]: Refreshing state... [id=76222e1321ba17684ec09adf7142f25a12867550cf81834fc583575244a14b12]
local_file.ansible_inventory: Refreshing state... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
null_resource.provision: Refreshing state... [id=4730705910091877190]

Changes to Outputs:
  + target_node1_ip_direct = "172.20.0.4"

You can apply this plan to save these new output values to the Terraform state, without changing any real infrastructure.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes


Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

Outputs:

target_node1_ip_direct = "172.20.0.4"
target_nodes_ips = {
  "target-node1" = "172.20.0.4"
  "target-node2" = "172.20.0.3"
  "target-node3" = "172.20.0.2"
}
````

ここからが、セクション4との違いです。Terraform担当は、この出力値をtfstateから直接渡すのではなく、`terraform output -json`で中間ファイルにエクスポートします。

**実行コマンド**
````plaintext
terraform output -json target_node1_ip_direct > inventory_vars.json
cat inventory_vars.json
````

**▼ 実行結果**
````plaintext
"172.20.0.4"
````

Ansible担当は、tfstateではなくこの中間ファイルだけを参照するスクリプトを使います。

* **ファイル名：**`read_state_via_export.py`
````python
#!/usr/bin/env python3
import json

with open("inventory_vars.json") as f:
    ip = json.load(f)

print(ip)
````

**実行コマンド**

````plaintext
python3 read_state_via_export.py
````

**▼ 実行結果**
````plaintext
172.20.0.4
````

この状態を起点に、セクション4と全く同じ変更、`output`の名前だけをTerraform担当がリファクタリングします。

* **ファイル名：**`main.tf`（変更部分）
````hcl
output "node1_ip" {
  value = docker_container.targets["target-node1"].network_data[0].ip_address
}
````

**実行コマンド**
````plaintext
terraform apply
````

**▼ 実行結果**
````plaintext
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node2"]: Refreshing state... [id=76222e1321ba17684ec09adf7142f25a12867550cf81834fc583575244a14b12]
docker_container.targets["target-node3"]: Refreshing state... [id=c0bf3acaad8594c22759d078da57ecea563acd09c383d5c0cd8e8eabb32ba1ea]
docker_container.targets["target-node1"]: Refreshing state... [id=2dacb702c37e4ef0af967e2a09467936cd99653d2b9223042600fe3d522e867f]
local_file.ansible_inventory: Refreshing state... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
null_resource.provision: Refreshing state... [id=4730705910091877190]

Changes to Outputs:
  + node1_ip               = "172.20.0.4"
  - target_node1_ip_direct = "172.20.0.4" -> null

You can apply this plan to save these new output values to the Terraform state, without changing any real infrastructure.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

Outputs:

node1_ip = "172.20.0.4"
target_nodes_ips = {
  "target-node1" = "172.20.0.4"
  "target-node2" = "172.20.0.3"
  "target-node3" = "172.20.0.2"
}
````

`apply`は完了しましたが、`inventory_vars.json`はまだ再エクスポートしていません。この状態で、Ansible担当のスクリプトを再実行します。

**実行コマンド**
````plaintext
python3 read_state_via_export.py
````

**▼ 実行結果**
````plaintext
172.20.0.4
````

セクション4では同じ操作の直後に`KeyError`で停止しましたが、今回はスクリプトが問題なく動作しています。中間ファイルの中身自体は、`target_node1_ip_direct`という出力名がどうなったかを一切知らない、単なる`"172.20.0.4"`という値だからです。Ansible担当のスクリプトは、tfstateの構造にもTerraformの出力名にも依存せず、あくまで`inventory_vars.json`というファイルの中身だけを見ています。

最後に、Terraform担当が新しい出力名で中間ファイルを更新する運用を確認します。

**実行コマンド**
````plaintext
terraform output -json node1_ip > inventory_vars.json
cat inventory_vars.json
````

**▼ 実行結果**
````plaintext
"172.20.0.4"
````

**実行コマンド**
````plaintext
python3 read_state_via_export.py
````

**▼ 実行結果**
````plaintext
172.20.0.4
````

中間ファイルを更新した後も、Ansible担当のスクリプトは変更なしに動作し続けています。

### ■ 結果

セクション4と全く同じ「出力名のリファクタリング」を行ったにもかかわらず、今回はAnsible担当のスクリプトが即座に壊れることはありませんでした。この違いを生んでいるのは、Ansible担当が何を参照しているかという一点です。

tfstateを直接参照する構成では、Terraform担当の変更がそのままAnsible担当の実行結果に伝播しました。中間ファイルを経由する構成では、Terraform担当の変更は、Terraform担当が`terraform output -json`を実行して中間ファイルを更新するという、明示的な操作を挟むまでAnsible担当には一切伝わりません。

これは、中間ファイルという緩衝材が、Terraform担当の内部構造の変更と、Ansible担当が依存する外部インターフェースとを分離しているためです。Terraform担当は、`output`の名前や、参照するリソースの実装をどれだけ変更しても、最終的に中間ファイルとして書き出す値の意味さえ保てば、Ansible担当の作業に影響を与えません。逆にAnsible担当は、Terraformの内部構造を一切知らなくても、決まったファイル名と形式のファイルさえ読めれば、自分の作業を進められます。

この構成の責務分離は、中間ファイルの更新タイミングをTerraform担当がコントロールできるという点にも表れています。tfstateへの直接参照では、Terraform担当が`apply`した瞬間に、意図せずAnsible担当の前提が変わってしまいます。中間ファイル経由では、`terraform output -json`を実行するという1つの操作が、Terraform担当からAnsible担当への「更新の通知」として機能し、いつAnsible側に変更を反映させるかを、Terraform担当自身が判断できます。

ただし、この構成にも注意点があります。中間ファイルは、Terraform担当が`terraform output -json`を実行して更新するまで古い値のままです。更新を忘れると、Ansible担当は変更前の値を参照し続けます。中間ファイルの更新を`apply`後の手順として運用に組み込んでおく必要があります。

---

[↑ 目次に戻る](#-目次)

---

## 6. チーム運用におけるapply実行権限の設計

誰が`terraform apply`を実行できるかという権限設計を整理します。

セクション2、3で確認した通り、ローカル環境から誰でも自由に`apply`できる運用は、tfstateの競合リスクをそのまま抱えることになります。作業ディレクトリが分かれていれば上書きのリスクが、ロックがあってもロックで弾かれた後の重複作業や、異常終了によるロックの残留といった運用上の課題が残ります。この状態を放置したまま、セクション4、5で整理した役割分担の設計だけを整えても、そもそも誰でも`apply`を実行できる状態であれば、tfstateを複数人が扱うという根本の問題は解消されません。

これに対する設計方針として、以下を示します。

`terraform apply`の実行をCI/CDパイプライン経由に限定し、ローカルからの直接applyを禁止する運用方針です。この方針のもとでは、`apply`はパイプライン上の1つのジョブとしてのみ実行されます。同時に走るジョブを1つに制限する設定をパイプライン側に入れておけば、複数のジョブが同時に`apply`を実行する状況も避けられます。誰か個人のローカル環境から、思い立ったタイミングで`apply`を実行するという経路自体がなくなるため、セクション2、3で確認したような、複数人がそれぞれの環境から`apply`を実行してしまうという状況そのものが構造的に発生しなくなります。

もう1つの方針として、Ansible担当はPlaybookの実行権限のみを持ち、tfstateや`terraform apply`には関与しない権限設計があります。これは、セクション4、5で整理した役割分担の設計を、権限のレベルでも徹底する考え方です。Ansible担当がそもそも`terraform apply`を実行できない、あるいはtfstateにアクセスできない状態にしておけば、セクション4で確認したような「tfstateを直接参照する」という選択肢自体を取れなくなり、中間ファイル経由の参照が唯一の手段になります。

権限を分離することで、「誰が何に対して責任を持つか」が明確になります。tfstateへの書き込みはCI/CDパイプラインを通じてTerraform担当の変更のみに限定され、Ansible担当は中間ファイルを介した参照に限定されます。この分離は、セクション2で触れた「誰か一人だけがapplyする」という運用文化に依存した回避策とは異なり、権限という技術的な制約によって同じ結果を実現します。運用ルールを知らない、あるいは守らない人がいたとしても、権限がなければそもそも実行できないため、セクション2で指摘した「回避策が機能しなくなる」という弱点を持ちません。

なお、この権限設計をどのようなCI/CDパイプラインで実現するか、具体的な実装は第4部（改善、CI/CD自動化編）で扱います。ここでは、権限を分離するという設計方針そのものが、チーム運用における人的な運用ミスを構造的に防ぐ土台になるという点を押さえておきます。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* tfstateはローカルファイル、または共有バックエンドで管理される単一の状態ファイルである。同一ディレクトリ内の同時実行はローカルバックエンドでもロックされるが、作業ディレクトリが分かれたりtfstateがコピーされたりした範囲の保護は運用設計に委ねられている
* tfstateをGitで管理する運用は、機密情報漏洩とJSONマージの不整合という2つの観点でアンチパターンである。ローカルファイル運用における「誰か一人だけがapplyする」という回避策は、技術的な排他制御ではなく運用文化に依存するため、守らない人が一人でもいれば機能しなくなる
* 別々のディレクトリでそれぞれ独立にtfstateへ変更を加え、後発側のtfstateファイルで先発側を上書きすると、先発側の変更記録はtfstate上から失われる。また、tfstateから消えることと実体（ファイルやコンテナ）が消えることは同じ意味ではなく、tfstateだけを共有、上書きする操作は、記録が指し示すリソースの実体との対応関係そのものをズレさせる可能性がある
* state lockingは、同一tfstateに対する同時書き込みを技術的に防ぐ（この回ではローカルバックエンドで確認した。方式はバックエンドごとに異なる）。ただし、ロックエラーを読み流して重複作業をしてしまう、異常終了でロックが残ったまま誰も触れなくなるといった運用上の課題は、ロック機構だけでは解決しない。技術的な排他制御と運用ルールは別の問題であり、両方が揃って初めて競合は実質的に防げる
* Ansible担当がtfstateの出力値を直接参照する設計は、Terraform担当からすれば実インフラに影響しない些細な変更（出力名のリファクタリング等）であっても、Ansible側の処理を予告なく停止させる。tfstateを直接参照する構成は、2つの担当の作業を意図しない形で密結合させる
* `terraform output -json`による中間ファイルへのエクスポートは、Terraform担当の内部構造の変更と、Ansible担当が依存する外部インターフェースを分離する。中間ファイルの更新はTerraform担当が明示的に行う操作であり、いつAnsible側に変更を反映させるかをTerraform担当自身が判断できる。ただし、更新を忘れるとAnsible担当は古い値を参照し続けるため、`apply`後の手順として更新を運用に組み込む必要がある
* `terraform apply`の実行をCI/CDパイプライン経由に限定し、ローカルからの直接applyを禁止する権限設計は、複数人がそれぞれの環境から`apply`を実行できてしまう状況そのものを構造的になくす。Ansible担当がtfstateに関与できない権限設計は、中間ファイル経由の参照を唯一の手段にする

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)** では、`local-exec`経由でAnsibleが複数回実行される構成において、冪等性が確保されていないPlaybookが`terraform apply`自体の失敗につながる構造を整理しました。

今回はその先を扱い、視点を単一環境から複数人での運用に移しました。別々のディレクトリでtfstateを扱うと後発の上書きで先発の記録が失われる様子と、state lockingが同一ディレクトリ内の同時実行を技術的に防ぐ仕組みを実機で確認しました。あわせて、Terraform担当とAnsible担当がtfstateを直接共有することで生まれる結合度の高さと、中間ファイルによる責務分離、そしてapply実行権限をCI/CDパイプラインに限定する設計方針を整理しました。

次回は、運用を続ける中で生じる問題を扱います。運用中に`apt update`、`apt upgrade`を実行してパッケージのバージョンが上がると、バージョンを前提にしたAnsible Playbookが失敗するケースを取り上げます。複数人でtfstateを扱うことから生じる問題を扱った今回から、リソースの起動後にOS内部のパッケージが進んでいくことで生じる問題へと視点を移します。

**[次回：第16回：apt update／apt upgradeでパッケージが更新されると、バージョンを前提にしたAnsible Playbookが失敗する理由](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)　｜　[次の記事：【Ansible×Terraform編】第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題](https://qiita.com/juehara-crypto/items/c3e95e3bec11e07bbe75)**

---

> **🔍 今起きている症状・課題から、読むべき回を探したい方はこちら**
>
> 全50回で扱った症状・課題を、部をまたいで1か所に集めた逆引きリファレンスがあります。
> 症状・課題の一覧から原因の見当をつけ、該当する回のセクションまでたどれます。
>
> → **[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」逆引きリファレンス：全50回の症状・課題を5つの図から引く](https://qiita.com/juehara-crypto/items/bd2832993ef887e8022a)**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第2部：運用、ライフサイクル編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**|Terraformのplanが、手動やAnsibleによるOS内部の変更を検知できない理由―tfstateの管理範囲と、--check --diffによる補完|構築後に手動やAnsibleで変更したOS内部の状態は、tfstateの管理範囲の外にあるため、Terraformの`plan`では検知できない。Ansibleの`--check --diff`による補完と、インフラ層、OS層を二軸で確認、同期する手順を整理する。ドリフトシリーズとの接続を示す。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**|初期化スクリプト・コンテナ起動定義を変更してterraform applyを再実行すると、コンテナが作り直されてAnsibleの設定が消える理由―uploadブロックのforces replacementと、初期化処理とAnsibleの役割分離|初期化スクリプトやコンテナ起動定義の変更で`forces replacement`が発生し、リソースが破棄、再生成されて、Ansibleが設定済みのOS内部状態が消える課題。初期化処理とAnsibleの役割分離で消失の影響を小さくする設計を整理する。|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**|HCLの1行の変更でコンテナが破棄、再生成され、Ansibleの設定が消える理由―更新と再生成の分かれ目と、terraform planの「-/+」「forces replacement」による事前判定|HCLの1行の変更でも、属性によっては「更新」ではなく「破棄、再生成」となり、Ansibleが投入した設定が消える。`terraform plan`の`~`と`-/+`、`forces replacement`の注記から、`apply`前に再生成を見分ける方法を整理する。|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**|local-execで再実行されたAnsibleが失敗し、terraform applyが止まる理由―冪等でないcommand（mkdir）と、--check --diffでは検出できない限界|`local-exec`経由でAnsibleが複数回実行される構成で、冪等でないPlaybookが2回目の実行で失敗し、`terraform apply`自体の失敗につながる問題。専用モジュールへの置き換えと、`--check --diff`では検出できない限界を整理する。冪等性シリーズ、レガシーPlaybook引き継ぎの知識を実践に適用する回として位置づける。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**|複数人が別々のディレクトリでterraform applyしたtfstateを上書きすると記録が消え、出力名の変更だけでAnsibleのスクリプトも止まる理由―state lockingの守備範囲と、中間ファイルによる分離|複数人が別々のディレクトリで扱ったtfstateを上書きすると記録が消える問題と、Ansible担当がtfstateを直接参照すると、出力名の変更だけでスクリプトが止まる問題。state lockingの守備範囲と、中間ファイルによる分離、apply実行権限の設計を整理する。|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**|apt update／apt upgradeでパッケージが更新されると、バージョンを前提にしたAnsible Playbookが失敗する理由―Terraformのイメージ固定の範囲外と、aptモジュールでのバージョン指定|運用中に`apt update`、`apt upgrade`でパッケージが更新されると、バージョンを前提にしたAnsible Playbookが失敗する問題。Terraformのイメージ固定が及ばない範囲と、`apt`モジュールでのバージョン指定による制御を整理する。|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)**|リソースの再生成でIPアドレスが変わると、静的インベントリのままではAnsibleがUNREACHABLEになる理由―動的インベントリで追従できる範囲と、DNS・hostsなど追従できない参照|リソースの再生成でIPアドレスが変わると、書き換えていない静的インベントリではAnsibleが`UNREACHABLE`になる問題。動的インベントリで追従できる範囲と、DNSや`/etc/hosts`など追従できない参照を整理する。|
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)**|sensitive = trueを指定してもtfstateにパスワードが平文で残る理由―Ansible Vaultとの責務分担と、Vaultの誤用パターン|`sensitive = true`を指定しても、`output`の値がtfstateに平文で残る問題。TerraformとAnsible Vaultの責務分担と、Vaultの誤用パターンと回避策を整理する。|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)**|ベースイメージをUbuntu 22.04から24.04に切り替えると、ansible_python_interpreterでPython 3.10を固定したPlaybookがnot foundで失敗する理由―自動検出との違いと、/etc/apt/sources.listの形式変更|ベースイメージをUbuntu 22.04から24.04に切り替えると、`ansible_python_interpreter`をパスで固定したPlaybookが`not found`で失敗する問題。自動検出との違いと、`/etc/apt/sources.list`の形式変更、標準モジュールの抽象化の限界を整理する。|
|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-20/)**|運用編まとめ：第11〜19回のトラブルは、リソースを直し続ける運用と作り直す運用のどちらで起きるか―ステートフルならミュータブル、ステートレスならイミュータブルという使い分け|第11〜19回のトラブルを、リソースを直し続けるミュータブル運用と、作り直すイミュータブル運用の軸で整理する。ステートフルならミュータブル、ステートレスならイミュータブルという使い分けを着地点として示す。|

---

[↑ 目次に戻る](#-目次)

---
