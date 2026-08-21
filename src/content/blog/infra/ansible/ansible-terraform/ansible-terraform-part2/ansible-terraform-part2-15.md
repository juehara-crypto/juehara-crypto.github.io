---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第15回：チーム運用における状態管理ファイル（tfstate）の整合性維持'
description: 'Terraformを管理するエンジニアとAnsibleを実行するオペレーターが分業する体制において、tfstateへの同時操作が競合を引き起こす構造を整理する。state lockingによる技術的な防止策と、tfstate出力値の直接参照が生む結合度の高さ、中間ファイルによる責務分離という役割分担の設計パターンを理解する。'
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
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題** **※近日公開予定**

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

「`terraform apply`を実行したら、自分が追加したはずのリソースが消えていた」という経験はないでしょうか。

**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)** では、`local-exec`経由でAnsibleが複数回実行される構成において、冪等性が確保されていないPlaybookが`terraform apply`自体の失敗につながる構造を整理しました。この回まで、検証は一貫して1人がTerraformとAnsibleの両方を操作する前提で進めてきました。

しかし、実際の運用ではこの前提が成立しない場面があります。

* Terraformを管理するエンジニアと、Ansibleを実行するオペレーターが別のチームに分かれている
* 同じ`main.tf`に対して、複数人がそれぞれの作業ディレクトリから`terraform apply`を実行できる状態になっている
* Ansible側のインベントリが、Terraformのtfstateから直接値を読み取る構成になっている

こうした体制で起きるのが、「同じtfstateに対して複数人が同時に`terraform apply`を実行したら、片方の変更が消えた」という事象です。

正確に言うと、**tfstateはローカルファイル、または共有バックエンドで管理される単一の状態ファイルであり、同時書き込みに対する保護は、Terraform自体が自動的に提供するものではなく、運用設計に委ねられています**。この前提を踏まえずに複数人がtfstateへ同時にアクセスすると、一方の変更がもう一方によって上書きされる、あるいは意図しない形で消失することがあります。

この回では、視点を単一環境から複数人での運用に移し、tfstateという共有リソースへの同時操作がもたらす競合の構造を整理します。そのうえで、Terraform担当とAnsible担当という役割分担をどう設計すれば、この競合を防げるかを見ていきます。

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

* **実行コマンド**

```plaintext
cp -r ~/iac/docker-lab ~/iac/docker-lab-copy
```

複製後、両ディレクトリはそれぞれ独立したtfstateを持ちます。ここに、それぞれの作業者が加えた変更として、コンテナ操作を伴わない軽量なリソースを追加します。

作業者A（`~/iac/docker-lab`）の`main.tf`に、以下を追加します。

* **ファイル名：**`main.tf`（`~/iac/docker-lab`、追記部分）

```hcl
resource "local_file" "conflict_demo_a" {
  filename = "${path.module}/conflict_demo_a.txt"
  content  = "added by workspace A\n"
}
```

作業者Aの変更を`apply`します。

* **実行コマンド**
```plaintext
terraform plan
```

**▼ 実行結果**
```plaintext
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
```

* **実行コマンド**
```plaintext
terraform apply
```

**▼ 実行結果**
```plaintext
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
```

続いて、作業者B（`~/iac/docker-lab-copy`）の`main.tf`に、以下を追加します。

* **ファイル名：**`main.tf`（`~/iac/docker-lab-copy`、追記部分）
```hcl
resource "local_file" "conflict_demo_b" {
  filename = "${path.module}/conflict_demo_b.txt"
  content  = "added by workspace B\n"
}
```

ここで重要なのは、作業者Bが参照している`~/iac/docker-lab-copy`のtfstateは、複製した時点、つまり作業者Aの変更より前のtfstateのままだという点です。作業者Bはこの状態のまま、自分の変更を`apply`します。

* **実行コマンド**
```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
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
```

* **実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**
```plaintext
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
```

この時点で、両ディレクトリのtfstateがそれぞれ何を記録しているかを確認します。

* **実行コマンド**
```plaintext
terraform state list
```

**▼ 実行結果（`~/iac/docker-lab-copy`）**
```plaintext
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
```

* **実行コマンド**
```plaintext
cd ~/iac/docker-lab
terraform state list
```

**▼ 実行結果（`~/iac/docker-lab`）**
```plaintext
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
```

この時点では、2つのディレクトリはそれぞれ別々のtfstateファイルとして独立して存在しているため、作業者Aのtfstateには`conflict_demo_a`が、作業者Bのtfstateには`conflict_demo_b`が、互いに見えない状態でそれぞれ記録されています。ここからさらに一歩進め、後発側（作業者B）のtfstateが、先発側（作業者A）のtfstateファイルを物理的に上書きした場合を再現します。

* **実行コマンド**
```plaintext
cp ~/iac/docker-lab-copy/terraform.tfstate ~/iac/docker-lab/terraform.tfstate
```

上書き後、`~/iac/docker-lab`側で再度`state list`を確認します。

* **実行コマンド**
```plaintext
terraform state list
```

**▼ 実行結果**
```plaintext
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
```

`~/iac/docker-lab`のtfstateから、作業者Aが追加したはずの`local_file.conflict_demo_a`が消え、代わりに作業者Bの`local_file.conflict_demo_b`が記録されています。

ここで、tfstateから消えたことと、実体（このケースではファイル）が消えたことが同じ意味かどうかを確認します。

* **実行コマンド**
```plaintext
ls ~/iac/docker-lab/conflict_demo_a.txt ~/iac/docker-lab/conflict_demo_b.txt
```

**▼ 実行結果**
```plaintext
ls: cannot access '/home/control/iac/docker-lab/conflict_demo_b.txt': No such file or directory
/home/control/iac/docker-lab/conflict_demo_a.txt
```

`conflict_demo_a.txt`は実体として`~/iac/docker-lab`に残っています。tfstateの上書きによって消えたのはあくまでtfstate上の記録であり、Terraformが実際にファイルを削除したわけではありません。

一方で、tfstateが記録している`local_file.conflict_demo_b`の実体は`~/iac/docker-lab`には存在しません。

* **実行コマンド**
```plaintext
ls ~/iac/docker-lab-copy/conflict_demo_b.txt
```

**▼ 実行結果**
```plaintext
/home/control/iac/docker-lab-copy/conflict_demo_b.txt
```

実体は、作業者Bが実際に`apply`した`~/iac/docker-lab-copy`側に存在しています。`local_file`リソースの`filename`は`path.module`（HCLコードが置かれているディレクトリ）を基準とした相対パスで解決されるため、tfstateだけを別のディレクトリへコピーしても、そのtfstateが指すリソースの実体までは移動しません。

### ■ 結果

この検証から、2つのことが確認できました。

1つ目は、当初想定していた通りの結果です。ローカルのtfstateに対して2人の作業者がそれぞれ独立に変更を加え、後発側のtfstateファイルで先発側のtfstateファイルを上書きすると、先発側の変更記録はtfstate上から失われます。tfstateはリソースの一覧を丸ごと保持する単一のファイルであり、差分だけをマージする仕組みを持っていません。上書きは常に「まるごと置き換え」になります。

2つ目は、検証の過程で追加で確認できた点です。tfstateから消えることと、リソースの実体が消えることは同じではありません。`conflict_demo_a.txt`はファイルとして残り続けていました。逆に、上書き後のtfstateが記録している`local_file.conflict_demo_b`は、そのtfstateを持つディレクトリには実体が存在せず、実際の実体は別のディレクトリに残っていました。tfstateはリソースの「状態の記録」であり、実体そのものではありません。tfstateだけを共有、あるいは上書きする操作は、その記録が指し示すリソースの実体がどこにあるかという対応関係そのものをズレさせる可能性があります。

いずれの結果も、tfstateがローカルファイルとして管理されている限り、複数人による同時操作に対する保護がTerraform自体には備わっていないことを示しています。次のセクションでは、この問題を技術的に防ぐ仕組みであるリモートバックエンドとstate lockingを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. リモートバックエンドとstate lockingによる競合防止

リモートバックエンドによる技術的な競合防止の仕組みを整理します。

クラウドストレージやTerraform Cloud等のリモートバックエンドは、state lockingという機能を提供します。`apply`実行時にロックを取得し、他の実行はそのロックが解除されるまで待機、またはエラーで弾かれる仕組みです。実は、本検証環境で使っているローカルバックエンド（`terraform.tfstate`をローカルファイルとして扱う構成）にも、同一ディレクトリ内での同時実行に対しては、この基本的なロック機構が備わっています。この仕組みを実機で確認します。

処理に時間のかかる操作を意図的に再現するため、`hashicorp/time`プロバイダーの`time_sleep`リソースを用意しました。

* **ファイル名：**`main.tf`（追記部分）

```hcl
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
```

`time_sleep`は`create_duration`で指定した時間だけ、実際に`apply`の処理を待機させるリソースです。インフラには一切影響しませんが、`apply`の処理時間を意図的に引き延ばすことができます。

### ■ 検証内容（同一ディレクトリに対する`terraform apply`の実行中に、別プロセスからの操作がstate lockingによって弾かれることの確認）

ターミナルを2つ用意し、片方（ターミナル1）で`apply`を実行している最中に、もう片方（ターミナル2）から同じディレクトリに対して`terraform plan`を実行します。

* **実行コマンド（ターミナル1）**

```plaintext
terraform apply
```

**▼ 実行結果（ターミナル1）**

```plaintext
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
```

ターミナル1の`apply`が実行中の間（`Still creating...`が表示されている間）に、ターミナル2で同じディレクトリに対して`plan`を実行します。

* **実行コマンド（ターミナル2）**

```plaintext
terraform plan
```

**▼ 実行結果（ターミナル2）**

```plaintext
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
```

ターミナル2の`plan`は、`Error acquiring the state lock`というエラーで即座に弾かれました。エラーメッセージには、ロックを保持しているのが誰か（`Who`）、どの操作か（`Operation`）、いつ取得されたか（`Created`）が明示されています。

ターミナル1の`apply`が完了した後、ターミナル2で改めて`plan`を実行し、ロックが解放されていることを確認します。

* **実行コマンド（ターミナル1側、apply完了後の確認）**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
No changes. Your infrastructure matches the configuration.
Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
```

ロックエラーは発生せず、正常に完了しています。

state lockingがあっても起きる運用上の競合にも触れておきます。

* ロックを取得できず弾かれた側が、そのままエラーメッセージを読み流し、後で重複して同じ作業をやり直してしまう人的なミス
* 異常終了（Ctrl+Cによる中断、SSHセッションの切断など）によってロックが残り続け、次に`apply`しようとした人が同じ`Error acquiring the state lock`に直面し、原因も分からないまま操作できなくなる詰まり

後者が発生した場合、ロックを保持しているプロセスが実際には動いていないことを確認した上で、以下のコマンドで明示的に解除します。

```plaintext
terraform force-unlock <LOCK_ID>
```

`<LOCK_ID>`には、エラーメッセージの`ID`欄に表示された値（今回の例であれば`3b4ec9e0-9583-f299-f9d4-76afc3733616`）を指定します。ロックファイルを直接削除するのではなく、このコマンドを使うことが推奨されます。

### ■ 結果

state lockingにより、同一ディレクトリのtfstateに対する同時操作は、片方が実行中である限り、もう片方が確実にエラーで弾かれることが確認できました。セクション2で確認した「ローカルファイルには保護がない」という状況と異なり、この場合は後発側の操作がそもそも実行されず、tfstateが上書きされることもありません。

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

```hcl
output "target_node1_ip_direct" {
  value = docker_container.targets["target-node1"].network_data[0].ip_address
}
```

続けて、この`output`をtfstateのJSONから直接パースするスクリプトを用意します。tfstateを直接参照する、Ansible担当が書いたインベントリ取得スクリプトという想定です。

* **ファイル名：**`read_state_direct.py`

```python
#!/usr/bin/env python3
import json

with open("terraform.tfstate") as f:
    state = json.load(f)

print(state["outputs"]["target_node1_ip_direct"]["value"])
```

`output`を反映させます。

* **実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
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
```

`output`の追加は既存のインフラリソースに変更を加えないため「No changes」と表示されつつ、出力自体は反映されています。

スクリプトが正常に値を取得できることを確認します。

* **実行コマンド**

```plaintext
python3 read_state_direct.py
```

**▼ 実行結果**

```plaintext
172.20.0.4
```

スクリプトが正しくIPアドレスを取得できました。この状態を起点に、Terraform担当側の視点で、些細なつもりの変更を加えます。`output`の名前を、値の中身は変えずに変更するだけです。

* **ファイル名：**`main.tf`（変更部分）

```hcl
output "node1_ip" {
  value = docker_container.targets["target-node1"].network_data[0].ip_address
}
```

* **実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
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
```

`without changing any real infrastructure`と明示されている通り、実インフラには一切変更がありません。Terraform担当からすれば、単なる出力名のリファクタリングに過ぎない変更です。

* **実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
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
```

この状態で、Ansible担当側のスクリプト（コード自体は一切変更していません）を再度実行します。

* **実行コマンド**

```plaintext
python3 read_state_direct.py
```

**▼ 実行結果**

```plaintext
Traceback (most recent call last):
  File "/home/control/iac/docker-lab/read_state_direct.py", line 7, in <module>
    print(state["outputs"]["target_node1_ip_direct"]["value"])
KeyError: 'target_node1_ip_direct'
```

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

セクション4と同じ状況を再現するため、まず同じ`output`を再度追加します。

* **ファイル名：**`main.tf`（追記部分）
```hcl
output "target_node1_ip_direct" {
  value = docker_container.targets["target-node1"].network_data[0].ip_address
}
```

* **実行コマンド**
```plaintext
terraform apply
```

**▼ 実行結果**
```plaintext
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
```

ここからが、セクション4との違いです。Terraform担当は、この出力値をtfstateから直接渡すのではなく、`terraform output -json`で中間ファイルにエクスポートします。

* **実行コマンド**
```plaintext
terraform output -json target_node1_ip_direct > inventory_vars.json
cat inventory_vars.json
```

**▼ 実行結果**
```plaintext
"172.20.0.4"
```

Ansible担当は、tfstateではなくこの中間ファイルだけを参照するスクリプトを使います。

* **ファイル名：**`read_state_via_export.py`
```python
#!/usr/bin/env python3
import json

with open("inventory_vars.json") as f:
    ip = json.load(f)

print(ip)
```

* **実行コマンド**

```plaintext
python3 read_state_via_export.py
```

**▼ 実行結果**
```plaintext
172.20.0.4
```

この状態を起点に、セクション4と全く同じ変更、`output`の名前だけをTerraform担当がリファクタリングします。

* **ファイル名：**`main.tf`（変更部分）
```hcl
output "node1_ip" {
  value = docker_container.targets["target-node1"].network_data[0].ip_address
}
```

* **実行コマンド**
```plaintext
terraform apply
```

**▼ 実行結果**
```plaintext
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
```

`apply`は完了しましたが、`inventory_vars.json`はまだ再エクスポートしていません。この状態で、Ansible担当のスクリプトを再実行します。

* **実行コマンド**
```plaintext
python3 read_state_via_export.py
```

**▼ 実行結果**
```plaintext
172.20.0.4
```

セクション4では同じ操作の直後に`KeyError`で停止しましたが、今回はスクリプトが問題なく動作しています。中間ファイルの中身自体は、`target_node1_ip_direct`という出力名がどうなったかを一切知らない、単なる`"172.20.0.4"`という値だからです。Ansible担当のスクリプトは、tfstateの構造にもTerraformの出力名にも依存せず、あくまで`inventory_vars.json`というファイルの中身だけを見ています。

最後に、Terraform担当が新しい出力名で中間ファイルを更新する運用を確認します。

* **実行コマンド**
```plaintext
terraform output -json node1_ip > inventory_vars.json
cat inventory_vars.json
```

**▼ 実行結果**
```plaintext
"172.20.0.4"
```

* **実行コマンド**
```plaintext
python3 read_state_via_export.py
```

**▼ 実行結果**
```plaintext
172.20.0.4
```

中間ファイルを更新した後も、Ansible担当のスクリプトは変更なしに動作し続けています。

### ■ 結果

セクション4と全く同じ「出力名のリファクタリング」を行ったにもかかわらず、今回はAnsible担当のスクリプトが即座に壊れることはありませんでした。この違いを生んでいるのは、Ansible担当が何を参照しているかという一点です。

tfstateを直接参照する構成では、Terraform担当の変更がそのままAnsible担当の実行結果に伝播しました。中間ファイルを経由する構成では、Terraform担当の変更は、Terraform担当が`terraform output -json`を実行して中間ファイルを更新するという、明示的な操作を挟むまでAnsible担当には一切伝わりません。

これは、中間ファイルという緩衝材が、Terraform担当の内部構造の変更と、Ansible担当が依存する外部インターフェースとを分離しているためです。Terraform担当は、`output`の名前や、参照するリソースの実装をどれだけ変更しても、最終的に中間ファイルとして書き出す値の意味さえ保てば、Ansible担当の作業に影響を与えません。逆にAnsible担当は、Terraformの内部構造を一切知らなくても、決まったファイル名と形式のファイルさえ読めれば、自分の作業を進められます。

この構成の責務分離は、中間ファイルの更新タイミングをTerraform担当がコントロールできるという点にも表れています。tfstateへの直接参照では、Terraform担当が`apply`した瞬間に、意図せずAnsible担当の前提が変わってしまいます。中間ファイル経由では、`terraform output -json`を実行するという1つの操作が、Terraform担当からAnsible担当への「更新の通知」として機能し、いつAnsible側に変更を反映させるかを、Terraform担当自身が判断できます。

---

[↑ 目次に戻る](#-目次)

---

## 6. チーム運用におけるapply実行権限の設計

誰が`terraform apply`を実行できるかという権限設計を整理します。

セクション2、3で確認した通り、ローカル環境から誰でも自由に`apply`できる運用は、tfstateの競合リスクをそのまま抱えることになります。ローカルファイルであれば上書きのリスクが、リモートバックエンドであってもロックを無視した重複作業や、異常終了によるロックの残留といった運用上の課題が残ります。この状態を放置したまま、セクション4、5で整理した役割分担の設計だけを整えても、そもそも誰でも`apply`を実行できる状態であれば、tfstateへの同時操作という根本の問題は解消されません。

これに対する設計方針として、以下を示します。

`terraform apply`の実行をCI/CDパイプライン経由に限定し、ローカルからの直接applyを禁止する運用方針です。この方針のもとでは、`apply`はパイプライン上の1つのジョブとしてのみ実行され、同時に走るジョブは1つに制限されます。誰か個人のローカル環境から、思い立ったタイミングで`apply`を実行するという経路自体がなくなるため、セクション2、3で確認したような、複数人が同時に`apply`を叩いてしまうという状況そのものが構造的に発生しなくなります。

もう1つの方針として、Ansible担当はPlaybookの実行権限のみを持ち、tfstateや`terraform apply`には関与しない権限設計があります。これは、セクション4、5で整理した役割分担の設計を、権限のレベルでも徹底する考え方です。Ansible担当がそもそも`terraform apply`を実行できない、あるいはtfstateにアクセスできない状態にしておけば、セクション4で確認したような「tfstateを直接参照する」という選択肢自体を取れなくなり、中間ファイル経由の参照が唯一の手段になります。

権限を分離することで、「誰が何に対して責任を持つか」が明確になります。tfstateへの書き込みはCI/CDパイプラインを通じてTerraform担当の変更のみに限定され、Ansible担当は中間ファイルを介した参照に限定されます。この分離は、セクション2で触れた「誰か一人だけがapplyする」という運用文化に依存した回避策とは異なり、権限という技術的な制約によって同じ結果を実現します。運用ルールを知らない、あるいは守らない人がいたとしても、権限がなければそもそも実行できないため、セクション2で指摘した「回避策が機能しなくなる」という弱点を持ちません。

なお、この権限設計をどのようなCI/CDパイプラインで実現するか、具体的な実装は第32回で扱います。ここでは、権限を分離するという設計方針そのものが、チーム運用における人的な運用ミスを構造的に防ぐ土台になるという点を押さえておきます。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* tfstateはローカルファイル、または共有バックエンドで管理される単一の状態ファイルであり、同時書き込みに対する保護は運用設計に委ねられている
* tfstateをGitで管理する運用は、機密情報漏洩とJSONマージの不整合という2つの観点でアンチパターンである。ローカルファイル運用における「誰か一人だけがapplyする」という回避策は、技術的な排他制御ではなく運用文化に依存するため、守らない人が一人でもいれば機能しなくなる
* ローカルのtfstateに対して複数人が独立に変更を加え、後発側のtfstateファイルで先発側を上書きすると、先発側の変更記録はtfstate上から失われる。また、tfstateから消えることと実体（ファイルやコンテナ）が消えることは同じ意味ではなく、tfstateだけを共有、上書きする操作は、記録が指し示すリソースの実体との対応関係そのものをズレさせる可能性がある
* リモートバックエンドのstate lockingは、同一tfstateに対する同時書き込みを技術的に防ぐ。ただし、ロックエラーを読み流して重複作業をしてしまう、異常終了でロックが残ったまま誰も触れなくなるといった運用上の課題は、ロック機構だけでは解決しない。技術的な排他制御と運用ルールは別の問題であり、両方が揃って初めて競合は実質的に防げる
* Ansible担当がtfstateの出力値を直接参照する設計は、Terraform担当からすれば実インフラに影響しない些細な変更（出力名のリファクタリング等）であっても、Ansible側の処理を予告なく停止させる。tfstateを直接参照する構成は、2つの担当の作業を意図しない形で密結合させる
* `terraform output -json`による中間ファイルへのエクスポートは、Terraform担当の内部構造の変更と、Ansible担当が依存する外部インターフェースを分離する。中間ファイルの更新はTerraform担当が明示的に行う操作であり、いつAnsible側に変更を反映させるかをTerraform担当自身が判断できる
* `terraform apply`の実行をCI/CDパイプライン経由に限定し、ローカルからの直接applyを禁止する権限設計は、複数人が同時に`apply`を実行できてしまう状況そのものを構造的になくす。Ansible担当がtfstateに関与できない権限設計は、中間ファイル経由の参照を唯一の手段にする

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)** では、`local-exec`経由でAnsibleが複数回実行される構成において、冪等性が確保されていないPlaybookが`terraform apply`自体の失敗につながる構造を整理しました。

今回はその先を扱い、視点を単一環境から複数人での運用に移しました。ローカルのtfstateに対する複数人の同時操作が競合を引き起こす様子と、リモートバックエンドのstate lockingがこれを技術的に防ぐ仕組みを実機で確認しました。あわせて、Terraform担当とAnsible担当がtfstateを直接共有することで生まれる結合度の高さと、中間ファイルによる責務分離、そしてapply実行権限をCI/CDパイプラインに限定する設計方針を整理しました。

次回は、時間経過によって生じる問題を扱います。運用中に`apt update`等を実行した結果、OSのライブラリやミドルウェアのバージョンが上がり、Terraformの定義と矛盾が生じるケースを取り上げます。チーム運用での人的な競合リスクを扱った今回から、時間の経過そのものがTerraform定義との間に生む矛盾へと視点を移します。

**[次回：第16回：パッケージアップデートに伴う環境の非互換性への対応](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)　｜　[次の記事：【Ansible×Terraform編】第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第2部：運用・ライフサイクル編

|回数|テーマ・記事タイトル|概要|
|---|---|---|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**|手動変更による構成ドリフトの検知と同期手法|構築後に手動やAnsibleで変更したOS内部の状態を、Terraformの`plan`が検知できず、インフラの管理状態に不整合が出る問題。ドリフトシリーズとの接続を示す。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**|`terraform apply`実行時における初期化処理とOS設定の上書き問題|Terraform側で初期化スクリプトやコンテナ起動定義を書き換えて再実行した際、Ansibleによって設定済みのOS内部状態が初期化される課題。|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**|コード修正に伴うリソースの強制再生成（リビルド）リスク|TerraformのHCL定義変更によって、リソースが「更新」ではなく「破棄、再生成」され、Ansibleが投入した内部データが消失する課題。|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**|複数回実行時におけるAnsible Playbookの冪等性の確保|`terraform apply`のlocal-exec経由でAnsibleが複数回実行される構成において、冪等性が確保されていないPlaybookがterraform apply自体の失敗を引き起こす問題。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**|チーム運用における状態管理ファイル（tfstate）の整合性維持|Ansibleを実行するオペレーターと、Terraformを管理するエンジニア間で、Terraformの状態管理ファイルに競合が発生するリスク。チーム運用での役割分担設計も整理する。|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**|パッケージアップデートに伴う環境の非互換性への対応|運用中に`apt update`等を実行した結果、OSのライブラリやミドルウェアのバージョンが上がり、Terraformの定義と矛盾が生じるケース。|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)**|リソース再生成時におけるIPアドレス変動と接続情報の更新遅延|リソース（コンテナ/VM）の再生成に伴ってIPアドレスが変更された際、Ansible用のインベントリや各種設定ファイルの書き換えが追いつかない問題。|
|第18回|TerraformとAnsible Vaultにおける機密情報の役割分担|データベースのパスワードやAPIキーなどの機密情報を、両ツールのどちらで暗号化し、どのように管理すべきかの運用設計。Vault誤用パターンと回避策も整理する。|
|第19回|OSのメジャーバージョンアップ時におけるPlaybookの互換性検証|Terraform側でベースイメージ（例：Ubuntu 22.04→24.04）を変更した際、Ansibleの古い独自モジュールやシェルコマンドが機能しなくなる課題。|
|第20回|運用編まとめ：ミュータブル運用とイミュータブル運用の折衷案|状態（データ）を維持し続ける運用（ミュータブル）と、使い捨てる運用（イミュータブル）を、両ツールの組み合わせでどのように着地させるかの最適解。|

---

[↑ 目次に戻る](#-目次)

---
