---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第2回：AnsibleとTerraformのGitOps上での責務分担'
description: 'AnsibleとTerraformの責務分担を、「ツールの担当範囲」ではなく「コミットされた変更の種類ごとに必要な実行」として捉え直す。変更の3分類、どちらのツールでも書ける設定の判定基準、AnsibleとTerraformの接続面がGitの外にあることを整理し、変更の種類ごとに必要な実行順序を示す。'
pubDate: 2026-09-29
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'tfstate', '構成管理']
seriesId: 'ansible-gitops-part1'
seriesNo: 2
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/'
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
2. [コミットされる変更の3分類](#2-コミットされる変更の3分類)
3. [どちらでも書ける設定の境界と判定基準](#3-どちらでも書ける設定の境界と判定基準)
4. [AnsibleとTerraformの接続面はGitの外にある](#4-ansibleとterraformの接続面はgitの外にある)
5. [変更の種類ごとに必要な実行順序](#5-変更の種類ごとに必要な実行順序)
6. [クラウドプロバイダーでも同じ境界問題が起きる理由](#6-クラウドプロバイダーでも同じ境界問題が起きる理由)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#9-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

Terraformでコンテナや仮想マシンを作成し、その内部の設定をAnsibleで投入する構成をGitで管理していて、

* Terraformはインフラのリソースを、AnsibleはOSの中の設定を担当している
* それぞれのコードをGitに置き、変更はコミットを通して反映している
* 役割分担は決まっているので、変更のたびにどちらを動かすかで迷うことはない

と考えていないでしょうか。

AnsibleとTerraformの役割分担は、多くの記事で「Terraformで作って、Ansibleで設定する」という一文で説明されています。この説明は、リソースを初めて作るときの流れとしては正しいものです。しかし、作った後に変更を加える場面で、どちらのツールをどう動かせばよいかまでは示していません。GitOpsで運用すると、変更はすべてコミットとして届くため、次のような場面にぶつかります。

* コンテナに渡す環境変数を、Terraformのリソース定義に書くか、Ansibleで設定ファイルに書くかで迷う
* Terraform側の小さな修正をコミットして適用したら、Ansibleで投入した設定が消えた
* ノードを1台追加するコミットで、Terraformのリソース定義のほかにAnsible側のどこを直し、どの順序で実行すればよいかが決まっていない

これらは、どちらのツールが何を担当するかは分かっているのに起きています。共通しているのは、変更がコミットされたときに、どちらのツールを、どの順序で動かす必要があるかが決まっていない点です。

この役割分担は、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも扱ってきました。Ansible×Terraformシリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-01/)** では、Terraformはインフラのリソースを宣言的に、AnsibleはOSの中を手続き的に管理するという役割分担を整理しました。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** では、`terraform plan`が検知できるのはtfstateに記録されたリソースの属性に限られ、`ansible-playbook --check --diff`が検知できるのはPlaybookが管理している範囲に限られることを確認しました。そのうえで、インフラ層とOS層の確認と同期は、二軸として両方行う必要があると整理しました。役割分担と確認の二軸そのものは、この回では再解説しません。

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** では、「Gitが唯一の真実」が崩れる3つの経路を整理しました。そのうち、Gitを経由しない手動変更に対しては、変更の経路をGitに限定する仕組みを第2部（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** 〜 **[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**）で作ります。ただし、経路をGitに限定するには、その前に、どの変更をGitのどこで行い、どのツールで反映するかが決まっている必要があります。この回では、その前提を整理します。

正確に言うと、**GitOpsで問われるのは「どのツールが何を担当するか」ではなく、「ある変更がコミットされたとき、どちらのツールを、どの順序で動かす必要があるか」です**。この回で扱う問いは、「この変更はTerraformの担当か、Ansibleの担当か、両方か。それをコミット単位でどう判定するのか」です。

次のセクションでは、コミットされる変更を3つに分類します。

---

[↑ 目次に戻る](#-目次)

---

## 2. コミットされる変更の3分類

コミットされる変更を、反映するためにどちらのツールの実行が必要になるかで3つに分類し、そのうち2つを実機で確認します。

分類の基準は、変更したファイルの種類ではなく、その変更をインフラに反映するために、どちらのツールを実行する必要があるかです。

* Terraformだけで完結する変更：Terraformの実行だけで反映が終わり、Ansibleを実行する必要がない変更。例として、既存のコンテナに接続しない新しいリソース（ボリュームなど）の追加
* Ansibleだけで完結する変更：Ansibleの実行だけで反映が終わり、Terraformを実行する必要がない変更。例として、Playbookで配置している設定ファイルの内容の変更
* 両方にまたがる変更：Terraformの実行に加えて、Ansibleの実行も必要になる変更。例として、ノードの追加

Ansibleだけで完結する変更は、Playbookやロールだけを変更するもので、TerraformのコードであるHCLには触れません。Terraformが比較するのは、HCLの定義、tfstate、実際のリソースの属性であり、Playbookは比較の対象に入りません。この検証環境の`main.tf`も、PlaybookやロールのファイルをTerraformから参照していません。そのため、ここでは残りの2つを`terraform plan`で確認します。確認は計画の表示までとし、`terraform apply`は実行しません。

検証環境では、Ansibleのインベントリ（`inventory.ini`）を、Terraformの`local_file`リソースで、コンテナのIPアドレスから生成しています。

* **ファイル名：`main.tf`（該当箇所）**

```hcl
resource "local_file" "ansible_inventory" {
  filename = "${path.module}/inventory.ini"
  content = templatefile("${path.module}/inventory.tftpl", {
    ips = {
      for name, container in docker_container.targets :
      name => container.network_data[0].ip_address
    }
  })
}
```

* **ファイル名：`inventory.tftpl`**

```plaintext
[target_nodes]
%{ for name, ip in ips ~}
${name} ansible_host=${ip} ansible_user=ansible
%{ endfor ~}
```

`ips`は、`docker_container.targets`のすべてのコンテナから作られ、テンプレートはその全要素を`[target_nodes]`グループの下に1行ずつ書き出します。このため、`terraform plan`の結果に`local_file.ansible_inventory`が含まれるかどうかで、変更がAnsibleの接続先に影響するかを確認できます。

### ■ 検証内容：既存のコンテナに接続しない新規リソースの追加

どのコンテナにもマウントしないボリュームを、`main.tf`に追加します。

* **ファイル名：`main.tf`（追加箇所）**

```hcl
resource "docker_volume" "gitops02_unattached" {
  name = "gitops02-unattached-vol"
}
```

この状態で、`terraform plan`を実行します。

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # docker_volume.gitops02_unattached will be created
  + resource "docker_volume" "gitops02_unattached" {
      + driver     = (known after apply)
      + id         = (known after apply)
      + mountpoint = (known after apply)
      + name       = "gitops02-unattached-vol"
    }

Plan: 1 to add, 0 to change, 0 to destroy.

（途中省略：区切り線と-outオプションに関する注意書き）
```

### ■ 結果

計画に含まれたのは、`docker_volume.gitops02_unattached`の作成だけでした（`Plan: 1 to add, 0 to change, 0 to destroy.`）。既存のコンテナ（target-node1〜3）の再作成も、インベントリを生成している`local_file.ansible_inventory`の差分も含まれていません。

既存のコンテナにもインベントリにも影響しないため、この変更はTerraformの実行だけで反映でき、Ansibleを実行する必要はありません。

### ■ 検証内容：ノードの追加

次に、ノードを1台追加します。まず、Playbookがどのホストを対象にしているかを確認します。

* **ファイル名：`site.yml`**

```yaml
---
- name: 接続確認用Playbook
  hosts: target_nodes
  gather_facts: false
  tasks:
    - name: 疎通確認
      ansible.builtin.ping:
  roles:
    - common_setup
```

Playbookは、個々のホスト名ではなく、`target_nodes`グループを対象にしています。グループに属するホストは、インベントリで決まります。

`main.tf`の`locals`に、target-node4の定義を追加します。

* **ファイル名：`main.tf`（該当箇所）**

```hcl
locals {
  target_nodes = {
    "target-node1" = 2231
    "target-node2" = 2222
    "target-node3" = 2223
    "target-node4" = 2224
  }
  target_node_networks = {
    # （途中省略：target-node1〜3の行）
    "target-node4" = [docker_network.lab_net.name]
  }
}
```

この状態で、`terraform plan`を実行します。

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # docker_container.targets["target-node4"] will be created
  + resource "docker_container" "targets" {
      （途中省略：属性とブロックの一覧）
    }

  # local_file.ansible_inventory must be replaced
-/+ resource "local_file" "ansible_inventory" {
      ~ content              = <<-EOT
            [target_nodes]
            target-node1 ansible_host=172.19.0.2 ansible_user=ansible
            target-node2 ansible_host=172.19.0.3 ansible_user=ansible
            target-node3 ansible_host=172.19.0.4 ansible_user=ansible
        EOT -> (known after apply) # forces replacement
      （途中省略：ハッシュ値等の差分）
        # (3 unchanged attributes hidden)
    }

（途中省略：local_file.group_vars_target_nodesの再作成計画）

Plan: 3 to add, 0 to change, 2 to destroy.

Changes to Outputs:
  ~ target_nodes     = {
      + target-node4 = {
          + host = (known after apply)
          + port = 22
        }
        # (3 unchanged attributes hidden)
    }
  ~ target_nodes_ips = {
      + target-node4 = (known after apply)
        # (3 unchanged attributes hidden)
    }

（途中省略：区切り線と-outオプションに関する注意書き）
```

### ■ 結果

計画には、target-node4のコンテナの作成に加えて、`local_file.ansible_inventory`と`local_file.group_vars_target_nodes`の再作成が含まれました（`Plan: 3 to add, 0 to change, 2 to destroy.`）。既存の3台のコンテナは含まれていません。

target-node4のIPアドレスは`apply`の後に決まるため、インベントリの内容も`(known after apply)`になっています。テンプレートはすべてのコンテナを`[target_nodes]`グループに書き出し、`site.yml`はそのグループを対象にしているため、Playbookを変更しなくても、target-node4は作り直されたインベントリを通じてAnsibleの対象に入る構成です。

一方、新しく作られるコンテナの中身は、イメージと、`main.tf`の定義（`upload`ブロック等）に書かれた内容だけで決まります。Ansible×Terraformシリーズの **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で整理したとおり、Playbookで配置する設定は`main.tf`の定義に書かれていないため、作成時のコンテナには入りません。その設定を入れるには、`terraform apply`の後にAnsibleを実行する必要があります。そのため、ノードの追加は両方にまたがる変更になります。

なお、ロールをホストごとに割り当てる構成では、Playbookやインベントリのグループ定義の変更も必要になります。この検証環境では、グループ単位でロールを割り当てているため、変更は`main.tf`だけで済みます。

### 3分類のまとめ

2つの検証で変更したファイルは、どちらも`main.tf`だけでした。それでも、ボリュームの追加はTerraformの実行だけで反映でき、ノードの追加はAnsibleの実行も必要になります。どのツールの実行が必要になるかは、変更したファイルからは決まりません。

|分類|変更の例|変更するファイル|反映に必要な実行|
|---|---|---|---|
|Terraformだけで完結する変更|既存のコンテナに接続しないボリュームの追加|`main.tf`|Terraform|
|Ansibleだけで完結する変更|Playbookで配置する設定ファイルの内容の変更|Playbook、ロール|Ansible|
|両方にまたがる変更|ノードの追加|`main.tf`（ロールをホストごとに割り当てる構成では、Playbookやインベントリのグループ定義も）|Terraform、Ansible|

実行の順序と、リソースの再生成を伴う変更の扱いは、**[セクション5](#5-変更の種類ごとに必要な実行順序)** で整理します。次のセクションでは、どちらのツールでも書ける設定を、どちらに置くべきかの判定基準を扱います。

---

[↑ 目次に戻る](#-目次)

---

## 3. どちらでも書ける設定の境界と判定基準

AnsibleとTerraformのどちらでも書ける設定を具体例で整理し、どちらに置くかを決める判定基準を示します。

### 境界が曖昧になる設定

検証環境のコンテナは、次の`Dockerfile`から作ったイメージを使っています。

* **ファイル名：`Dockerfile`**

```dockerfile
FROM ubuntu:22.04

# 環境変数とパッケージのインストール
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    openssh-server \
    python3.10 \
    sudo \
    iproute2 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# SSHD の初期設定
RUN mkdir /var/run/sshd

# 検証用ユーザー（ansible）の作成と sudo 権限付与
ARG ANSIBLE_USER_PASSWORD
RUN useradd -m -s /bin/bash ansible && \
    echo "ansible:${ANSIBLE_USER_PASSWORD}" | chpasswd && \
    echo 'ansible ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# SSH公開鍵格納用のディレクトリ作成
RUN mkdir -p /home/ansible/.ssh && \
    chown -R ansible:ansible /home/ansible/.ssh && \
    chmod 700 /home/ansible/.ssh

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D"]
```

このイメージには、SSHサーバー（`openssh-server`）、Python、`sudo`などのパッケージと、Ansibleが接続に使う`ansible`ユーザーが含まれています。コンテナを作成するときには、`main.tf`の`upload`ブロックで、SSHの公開鍵などを配置しています。その後、Ansibleがコンテナに接続し、Playbookに書かれた設定を投入します。

このように、コンテナの中の状態を決める手段が、イメージ、Terraformのリソース定義、Ansibleの3つあるため、同じ設定をどこに書くかの選択が生まれます。代表的なものは次の3つです。

* 環境変数と設定ファイル：アプリケーションに渡す値を、Terraformの`docker_container`の`env`で環境変数として渡すか、Ansibleで設定ファイルに書くか
* イメージに焼き込むパッケージと、Ansibleで入れるパッケージ：パッケージを`Dockerfile`に書いてイメージに含めるか、コンテナの起動後にAnsibleでインストールするか
* コンテナ内の待ち受けポートと、外部公開ポート：SSHサーバーがコンテナの中で待ち受けるポートは、SSHサーバーの設定ファイル（`sshd_config`の`Port`）で決まり、Ansibleで変更できる。外部に公開するポートと、その転送先となるコンテナ内のポートは、`main.tf`の`ports`ブロック（`external`、`internal`）で決まり、Terraformでしか設定できない

3つ目は、どちらのツールでも書ける設定ではなく、1つの値が両方のツールにまたがる設定です。検証環境では、`Dockerfile`で待ち受けポートを変更していないため、SSHサーバーは既定の22番で待ち受け、`ports`の`internal = 22`と一致しています。ここで、Ansibleで`sshd_config`の`Port`だけを変えると、外部公開ポートの転送先の22番で待ち受けるサーバーがなくなり、外部から接続できなくなります。片方だけを変えると整合が崩れるという点で、同じ値を両方のツールで定義する二重管理と同じ構造です。二重管理は、Ansible×Terraformシリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-01/)** で、連携時の設計アンチパターンの1つとして整理しています。

### 判定基準

どちらに置くかは、次の2つの基準で判定します。

* その値が変わったとき、リソースを作り直すべきか
* その値のライフサイクルは誰に属するか

1つ目の基準は、値を変えたときに何が起きるかで判定するものです。Terraformのリソースの属性には、変更をその場で反映できる属性と、変更するとリソースの作り直しになる属性があります。作り直しになる属性に値を置くと、値を変えるたびにコンテナが作り直されます。作り直されたコンテナからは、Ansibleで投入した設定が失われます。これは、Ansible×Terraformシリーズの **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で確認した結果です。

環境変数がどちらに当たるかを、実機で確認します。

### ■ 検証内容：環境変数の追加

`docker_container.targets`に`env`を追加し、target-node1にだけ環境変数を渡します。

* **ファイル名：`main.tf`（該当箇所）**

**【変更前】**

```hcl
resource "docker_container" "targets" {
  for_each = local.target_nodes
  name     = each.key
  image    = docker_image.ansible_target.image_id
  # （途中省略：以降の定義）
}
```

**【変更後】**

```hcl
resource "docker_container" "targets" {
  for_each = local.target_nodes
  name     = each.key
  image    = docker_image.ansible_target.image_id
  env      = each.key == "target-node1" ? ["APP_ENV=production"] : []
  # （途中省略：以降の定義）
}
```

この状態で、`terraform plan`を実行します。

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] must be replaced
-/+ resource "docker_container" "targets" {
      （途中省略：envより前の属性の差分）
      ~ env                                         = [ # forces replacement
          + "APP_ENV=production",
        ]
      （途中省略：envより後の属性とブロックの差分）
    }

（途中省略：local_file.ansible_inventory、local_file.group_vars_target_nodesの再作成計画）

Plan: 3 to add, 0 to change, 3 to destroy.

（途中省略：Changes to Outputs、区切り線と-outオプションに関する注意書き）
```

### ■ 結果

target-node1は`must be replaced`となり、`env`の行に`# forces replacement`が付きました。環境変数を1つ追加しただけで、コンテナの作り直しが計画されています。target-node1のIPアドレスが作り直しの後に決まるため、インベントリを生成する`local_file`の2つも再作成の対象になりました。target-node2・3は計画に含まれていません。

`# forces replacement`は`env`属性に付いているため、環境変数の追加だけでなく、値の書き換えも同じ属性の変更として作り直しになります。つまり、環境変数で値を渡す構成では、値を変えるコミットのたびにコンテナが作り直され、Ansibleで投入した設定を入れ直す必要があります。**[セクション2](#2-コミットされる変更の3分類)** の分類に当てはめると、Terraformのコードだけを変える変更でも、両方にまたがる変更になります。

一方、同じ値をAnsibleで設定ファイルに書く場合、値の変更はコンテナの中のファイルの書き換えであり、コンテナの作り直しは伴いません。Ansibleの実行だけで完結する変更になります。

### ライフサイクルは誰に属するか

2つ目の基準は、その値がいつ、何と一緒に変わるかで判定するものです。

`Dockerfile`に書かれている`openssh-server`、`python3.10`、`sudo`は、Ansibleがコンテナに接続し、タスクを実行するために必要なものです。AnsibleはSSHで接続し、コンテナの中のPythonでモジュールを実行し、`become`で権限を昇格します。実際、検証環境の`ansible-playbook`の実行結果には、target-node1〜3で`/usr/bin/python3.10`を使った旨の警告が出ています。これらは、Ansibleを実行する前から存在している必要があるため、Ansibleでは入れられません。コンテナを作る時点で決まっている必要があり、ライフサイクルはイメージとコンテナの作成に属します。

これに対し、アプリケーションの設定値や、その設定のために入れるパッケージは、コンテナが動いている間に、アプリケーションの変更に合わせて変わります。このような値はAnsibleに置けば、変更のたびにコンテナを作り直す必要がありません。

待ち受けポートと外部公開ポートのように、1つの値が両方にまたがる設定は、どちらか一方に寄せることができません。この場合は、片方だけを変えるコミットを作らず、同じコミットで`main.tf`とPlaybookの両方を変え、両方にまたがる変更として扱います。

3つの設定に当てはめると、次のとおりです。

|設定|Terraform・イメージ側に置く場合|Ansible側に置く場合|判定の目安|
|---|---|---|---|
|環境変数と設定ファイル|`env`で渡す。値の変更はコンテナの作り直しになる|設定ファイルに書く。値の変更は作り直しを伴わない|コンテナが動いている間に値を変えるなら、Ansibleに置く|
|パッケージ|`Dockerfile`に書く。変更にはイメージとコンテナの作り直しが必要になる|起動後にインストールする。コンテナが作り直されると失われる|Ansibleの実行に必要なもの（SSHサーバー、Python、`sudo`）は、イメージに置く|
|待ち受けポートと外部公開ポート|`ports`の`internal`、`external`|`sshd_config`の`Port`|1つの値が両方にまたがる。同じコミットで両方を変える|

次のセクションでは、AnsibleとTerraformの接続面にある値が、Gitの外にあることを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 4. AnsibleとTerraformの接続面はGitの外にある

AnsibleとTerraformをつなぐ値が、Gitの外にあることを実機で確認し、GitOps上での扱いを整理します。

検証環境では、Terraformがコンテナを作成し、Ansibleはインベントリに書かれたIPアドレスでコンテナに接続します。**[セクション2](#2-コミットされる変更の3分類)** で見たとおり、インベントリはTerraformの`local_file`リソースが、コンテナのIPアドレスとテンプレートから生成しています。つまり、両ツールの接続面は、次のようにつながっています。

```
main.tf、テンプレート（IPアドレスの取り出し方と、インベントリの書式）
　↓ terraform apply
tfstate（作成したコンテナのIPアドレスを記録）
　↓ local_fileによる生成
inventory.ini（Ansibleの接続先）
　↓ ansible-playbook
コンテナ
```

この流れの中で、接続面の値であるIPアドレスが、どこにあり、Gitに含まれているかを確認します。

### ■ 検証内容：接続面の値の置き場所

まず、Terraformの`output`で、接続面の値を取り出します。

**実行コマンド**

```plaintext
terraform output
```

**▼ 実行結果**

```plaintext
target_nodes = {
  "target-node1" = {
    "host" = "172.19.0.2"
    "port" = 22
  }
  "target-node2" = {
    "host" = "172.19.0.3"
    "port" = 22
  }
  "target-node3" = {
    "host" = "172.19.0.4"
    "port" = 22
  }
}
target_nodes_ips = {
  "target-node1" = "172.19.0.2"
  "target-node2" = "172.19.0.3"
  "target-node3" = "172.19.0.4"
}
```

同じ値が、tfstateに記録されていることを確認します。

**実行コマンド**

```plaintext
grep -n '"ip_address"' terraform.tfstate
```

**▼ 実行結果**

```plaintext
121:                "ip_address": "172.19.0.2",
247:                "ip_address": "172.19.0.3",
373:                "ip_address": "172.19.0.4",
```

Terraformが生成したインベントリにも、同じ値が書かれています。

**実行コマンド**

```plaintext
cat inventory.ini
```

**▼ 実行結果**

```plaintext
[target_nodes]
target-node1 ansible_host=172.19.0.2 ansible_user=ansible
target-node2 ansible_host=172.19.0.3 ansible_user=ansible
target-node3 ansible_host=172.19.0.4 ansible_user=ansible
```

次に、Gitで管理しているファイルに、これらのIPアドレスが含まれているかを確認します。

**実行コマンド**

```plaintext
git grep -n -E '172\.(18|19)\.0\.[0-9]+'; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
exit_code=1
```

tfstateと、Terraformが生成したファイルが、Gitの管理対象に含まれているかを確認します。

**実行コマンド**

```plaintext
git ls-files --error-unmatch terraform.tfstate inventory.ini group_vars/target_nodes.yml; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
error: pathspec 'terraform.tfstate' did not match any file(s) known to git
error: pathspec 'inventory.ini' did not match any file(s) known to git
error: pathspec 'group_vars/target_nodes.yml' did not match any file(s) known to git
Did you forget to 'git add'?
exit_code=1
```

最後に、値を生み出す定義が、Gitで管理されているかを確認します。

**実行コマンド**

```plaintext
git ls-files | grep -E '\.tf$|\.tftpl$'
```

**▼ 実行結果**

```plaintext
group_vars_target_nodes.tftpl
inventory.tftpl
main.tf
outputs.tf
```

### ■ 結果

確認した内容を、Gitに含まれるかどうかで並べると、次のとおりです。

|置き場所|含まれるもの|Gitの管理対象か|
|---|---|---|
|`main.tf`、`outputs.tf`、テンプレート|IPアドレスの取り出し方と、インベントリの書式|含まれる|
|tfstate|作成したコンテナのIPアドレス|含まれない|
|`inventory.ini`、`group_vars/target_nodes.yml`|tfstateの値から生成した接続先|含まれない|

`git grep`は何も出力せずに`exit_code=1`で終わり、Gitで管理しているファイルに、接続先のIPアドレスは1つも含まれていませんでした。Gitにあるのは「値の作り方」だけで、Ansibleが実際に使う「値」は、tfstateと、そこから生成したファイルにしかありません。

### 接続面が「唯一の真実」の例外になる理由

IPアドレスは、コンテナを作成したときに、Dockerがネットワークの空いているアドレスから割り当てます。**[セクション2](#2-コミットされる変更の3分類)** のノード追加の`terraform plan`で、インベントリの内容が`(known after apply)`になっていたのはこのためです。**[セクション3](#3-どちらでも書ける設定の境界と判定基準)** の環境変数の追加でも、同じ理由でインベントリが再作成の対象になりました。値は`terraform apply`の後にしか決まらず、コミットの時点では書けません。

また、この値は、Gitへの変更と関係なく変わります。Ansible×Terraformシリーズの **[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** では、コンテナの作り直しでIPアドレスが変わると、古いインベントリのままAnsibleを実行した場合に、接続に失敗するか、意図しないホストに接続することを整理しました。仮に`inventory.ini`をGitにコミットしても、コンテナが作り直された時点で、Gitにある値は実際の接続先と食い違います。

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** では、「Gitが唯一の真実」と言えるのは、Gitに記述されている範囲の中だけだと整理しました。AnsibleとTerraformの接続面は、最初からこの範囲の外にあります。

### GitOps上での扱い

接続面の値は、Gitに入れるのではなく、実行のたびにtfstateから生成し、その生成手順をGitで管理します。検証環境の`main.tf`とテンプレートは、この考え方に沿った構成です。値そのものはGitの外にあっても、どの値をどう取り出し、どの書式でAnsibleに渡すかはGitに記録されているため、同じtfstateからは同じインベントリが生成されます。

このため、接続面を使う変更では、Terraformを先に実行してtfstateを更新し、インベントリを生成し直してからAnsibleを実行する順序が必要になります。この順序は、**[セクション5](#5-変更の種類ごとに必要な実行順序)** で整理します。

生成手順をパイプラインの中でどう実装するかは **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で、どのファイルをGitに置き、どのファイルを置かないかの設計は **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で扱います。値を持つtfstate自体の置き場所は、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** で扱います。

次のセクションでは、ここまでの分類をもとに、変更の種類ごとに必要な実行順序を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. 変更の種類ごとに必要な実行順序

**[セクション2](#2-コミットされる変更の3分類)** から **[セクション4](#4-ansibleとterraformの接続面はgitの外にある)** の結果をもとに、変更の種類ごとに、どのツールをどの順序で実行する必要があるかを整理します。

実行順序の原則は、Ansible×Terraformシリーズの **[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** で整理しています。インフラ層とOS層の同期は、通常はどちらを先に実行してもよく、インフラ層の変更がAnsibleの適用対象（接続先、認証情報など）に影響する場合は、Terraformを先に実行する必要があります。判断に迷う場合は、Terraform→Ansibleの順序で統一しておくと、順序に起因する問題を避けやすくなります。

**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** が扱ったのは、手動変更によるずれを確認し、同期する場面でした。この回で扱うのは、コミットされた変更を反映する場面です。この場面では、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** の原則に、次の2点が加わります。

* Ansibleだけで完結する変更では、Terraformを実行する必要がない
* リソースの再生成を伴うTerraformの変更では、順序だけでなく、作り直したリソースに対してPlaybookの全タスクを適用し直す必要がある

### 再生成を伴う変更を分けて扱う理由

**[セクション3](#3-どちらでも書ける設定の境界と判定基準)** で確認したとおり、環境変数の追加は、`main.tf`だけを変える変更でありながら、コンテナの作り直し（`must be replaced`）を伴います。Ansible×Terraformシリーズの **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** では、作り直したコンテナから、Ansibleで配置したファイルとインストールしたパッケージが、どちらも失われることを確認しました。`terraform apply`はエラーも警告も出さずに完了するため、Terraformの実行結果だけでは、この消失に気づけません。

作り直したコンテナは、イメージと`main.tf`の定義に書かれた内容だけを持った状態で作られます。そのため、Ansibleの実行は、今回の変更に関係するタスクだけでは足りず、Playbookのすべてのタスクで設定を入れ直す必要があります。変更の内容はTerraformの1つの属性でも、Ansible側では、新しいノードを追加したときと同じだけの作業が必要になります。

この点で、再生成を伴う変更は、**[セクション2](#2-コミットされる変更の3分類)** の3分類のうち「両方にまたがる変更」に含まれますが、変更したファイルからはそう見えないため、分けて扱います。

### 変更の種類と必要な実行

この回で確認した`terraform plan`の結果を、変更の種類を見分ける手がかりとして並べると、次のとおりです。

|変更の種類|この回で確認した例|`terraform plan`に現れるもの|必要な実行|
|---|---|---|---|
|Terraformだけで完結する変更|既存のコンテナに接続しないボリュームの追加（**[セクション2](#2-コミットされる変更の3分類)**）|追加するリソースだけ。コンテナとインベントリは含まれない|`terraform apply`|
|Ansibleだけで完結する変更|Playbookで配置する設定ファイルの内容の変更|HCLを変更しないため、差分は現れない|`ansible-playbook`|
|両方にまたがる変更|ノードの追加（**[セクション2](#2-コミットされる変更の3分類)**）|コンテナの`will be created`と、インベントリの再作成|`terraform apply`→`ansible-playbook`|
|再生成を伴うTerraformの変更|環境変数の追加（**[セクション3](#3-どちらでも書ける設定の境界と判定基準)**）|コンテナの`must be replaced`と、インベントリの再作成|`terraform apply`→`ansible-playbook`（作り直したコンテナに、Playbookの全タスクを適用し直す）|

Terraformが先になる変更は、どちらも`terraform plan`にインベントリの再作成が含まれていました。**[セクション4](#4-ansibleとterraformの接続面はgitの外にある)** で確認したとおり、Ansibleの接続先はtfstateから生成されるため、Terraformの実行が終わってインベントリが生成し直されるまで、Ansibleは正しい接続先を知ることができません。

逆に言えば、コミットの時点で`terraform plan`を確認すれば、そのコミットがどの種類に当たるかを見分けられます。コンテナの`must be replaced`が含まれていれば、`main.tf`だけの変更であっても、Playbookの全タスクの適用が必要な変更です。

### 第2部のパイプライン設計への入力

この表は、第2部で作るパイプラインの設計に、そのまま入力として使います。どの変更で、どのツールを、どの順序で実行するかは、パイプラインのトリガー条件とジョブの順序になります。プルリクエストで確認し、マージで適用する基本の構成は **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で、`terraform plan`から再生成や削除を検知して、Ansibleの設定の消失を適用前に扱う仕組みは **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** で扱います。

次のセクションでは、この回で整理した境界の問題が、クラウドのプロバイダーでも同じように起きる理由を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. クラウドプロバイダーでも同じ境界問題が起きる理由

この回で整理した境界の問題が、Dockerプロバイダーに固有のものではなく、クラウドのプロバイダーでも同じ構造で起きることを整理します。

### 仮想マシンの中身を決める3つの手段

Dockerの構成要素とAWS・GCPのリソースの対応は、本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション8で整理しました。ここでは、その対応のうち、コンテナや仮想マシンの中身を決める手段に絞って見ます。

**[セクション3](#3-どちらでも書ける設定の境界と判定基準)** では、コンテナの中の状態を決める手段が、イメージ、Terraformのリソース定義、Ansibleの3つあることを確認しました。クラウドの仮想マシンでも、手段は同じく3つあります。

|手段|Docker（検証環境）|AWS|GCP|
|---|---|---|---|
|イメージに焼く|`Dockerfile`から作ったイメージ|AMI|マシンイメージ（`boot_disk`の`image`）|
|起動時に渡す|`docker_container`の`env`、`upload`|`aws_instance`の`user_data`（cloud-init等）|`google_compute_instance`の`metadata`の`startup-script`、`metadata_startup_script`|
|起動後に入れる|Ansible|Ansible|Ansible|

どの設定をどの手段で入れるかという選択は、プロバイダーが変わってもそのまま残ります。「イメージに焼くか、起動時に渡すか、Ansibleで入れるか」は、AWSでもGCPでも同じ境界の問題です。

### 判定基準はそのまま使える

**[セクション3](#3-どちらでも書ける設定の境界と判定基準)** の2つの判定基準は、クラウドでもそのまま使えます。

1つ目の基準「その値が変わったとき、リソースを作り直すべきか」については、起動時に渡す値の変更が作り直しになるかどうかが、プロバイダーと、使う属性によって異なります。

* Docker：`env`の変更は、コンテナの作り直しになる（**[セクション3](#3-どちらでも書ける設定の境界と判定基準)** で確認）
* AWS：`user_data`の変更は、既定ではインスタンスの停止と起動になる。`user_data_replace_on_change`を`true`にすると、インスタンスの破棄と再作成になる（**[aws_instance](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/instance)**）
* GCP：`metadata`の`startup-script`の変更は、インスタンスの作り直しにならない。代わりに`metadata_startup_script`を使うと、変更がインスタンスの作り直しになる（**[google_compute_instance](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_instance)**）

同じ「起動時に渡す」手段でも、作り直しになるかどうかは一律ではありません。そのため、判定は、プロバイダーの種類からの推測ではなく、`terraform plan`に`# forces replacement`や`must be replaced`が現れるかどうかで行います。作り直しになる場合は、**[セクション5](#5-変更の種類ごとに必要な実行順序)** の「再生成を伴うTerraformの変更」として、Ansibleで全タスクを適用し直す必要があるのも、Dockerの場合と同じです。

2つ目の基準「その値のライフサイクルは誰に属するか」も、そのまま当てはまります。Ansibleが接続して実行するために必要なもの、つまりSSHサーバー、Python、権限昇格の手段、接続に使う公開鍵は、Ansibleを実行する前から仮想マシンにある必要があります。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション8で整理したとおり、公開鍵は、Dockerでは`upload`、AWSでは`key_name`または`user_data`、GCPでは`metadata`の`ssh-keys`で渡します。これらは、イメージか起動時に渡す値で用意するものであり、Ansibleで入れることはできません。

### 接続面もGitの外にある

**[セクション4](#4-ansibleとterraformの接続面はgitの外にある)** で確認した接続面の問題も、クラウドで同じように起きます。クラウドの仮想マシンでも、IPアドレスを固定しない限り、アドレスは作成時に割り当てられます。たとえばGCPの`network_interface`の`network_ip`は、指定しなければ自動で割り当てられます。割り当てられた値はtfstateに記録され、Gitには含まれません。値の生成手順をGitで管理し、実行のたびにtfstateから接続先を生成するという扱いは、プロバイダーを問わず同じです。

プロバイダーを差し替えて変わるのは、リソースの名前と属性の名前、そしてどの属性の変更が作り直しになるかという個々の挙動です。変わらないのは、仮想マシンの中身を決める手段が3つあり、どれを選ぶかで変更時に必要な実行が変わるという構造と、両ツールの接続面がGitの外にあるという構造です。

次のセクションでは、この回で整理した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* GitOpsでの責務分担は、「どのツールが何を担当するか」ではなく、「コミットされた変更を反映するために、どちらのツールを、どの順序で実行する必要があるか」として設計する
* コミットされる変更は、Terraformだけで完結する変更、Ansibleだけで完結する変更、両方にまたがる変更の3つに分類でき、分類は変更したファイルではなく、反映に必要な実行で決まる。既存のコンテナに接続しないボリュームの追加とノードの追加は、どちらも`main.tf`だけの変更だが、前者はTerraformだけで反映でき、後者はAnsibleの実行も必要になることを`terraform plan`で確認した
* どちらのツールでも書ける設定は、「その値が変わったとき、リソースを作り直すべきか」と「その値のライフサイクルは誰に属するか」の2つの基準で判定する。`docker_container`に環境変数を追加すると、コンテナの作り直しになることを実機で確認した
* 待ち受けポートと外部公開ポートのように、1つの値が両方のツールにまたがる設定は、片方だけを変えず、同じコミットで両方を変える
* AnsibleとTerraformの接続面であるIPアドレスは、tfstateと、そこから生成したインベントリにあり、Gitで管理しているファイルには含まれないことを実機で確認した。Gitで管理するのは値ではなく、値の生成手順である
* 再生成を伴うTerraformの変更は、`main.tf`だけの変更であっても、Terraform→Ansibleの順に実行し、作り直したリソースにPlaybookの全タスクを適用し直す必要がある。変更の種類は、`terraform plan`の結果から見分けられる
* この境界の問題はDockerプロバイダーに固有のものではなく、AWSやGCPでも、イメージに焼くか、起動時に渡すか、Ansibleで入れるかという同じ形で起きる。起動時に渡す値の変更が作り直しになるかはプロバイダーと属性によって異なるため、`terraform plan`で判定する

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** では、「Gitが唯一の真実」が崩れる3つの経路を整理し、Gitを経由しない手動変更に対しては、変更の経路をGitに限定する仕組みを第2部で作ることを示しました。第2回となる今回は、その前提として、AnsibleとTerraformの責務分担を「変更の種類ごとに必要な実行」として捉え直しました。コミットされる変更を3つに分類し、どちらのツールでも書ける設定を判定する2つの基準を示したうえで、両ツールの接続面がGitの外にあることを実機で確認しました。最後に、変更の種類ごとに必要な実行順序を整理し、この境界の問題がクラウドのプロバイダーでも同じ形で起きることを示しました。

次回は、この回で整理した変更の分類を、Gitリポジトリの構造に落とし込みます。変更の分類をパスで表現するディレクトリ構成、Gitに置くものと置かないもの、モノレポとマルチリポの選択基準、mainを唯一の真実とするブランチ運用を設計します。この回で確認した、tfstateや生成したインベントリをGitに置かないという扱いも、次回の「Gitに置かないもの」として整理します。

**[次回：第3回：GitリポジトリとAnsibleの構造設計](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)　｜　[次の記事：【GitOps編】第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第1部まとめブログ：「Gitが唯一の真実」を成り立たせる前提の設計** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「Ansible×TerraformをGitOpsで回す」

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