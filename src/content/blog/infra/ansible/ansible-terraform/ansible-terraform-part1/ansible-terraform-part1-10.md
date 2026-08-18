---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第10回：環境構築編まとめ：自動連携のためのコードテンプレート化'
description: '第1回〜9回で扱った環境構築・連携時のトラブルと解決策を総括し、TerraformからAnsibleへ一貫して安全に処理を移譲するための実行順序と、統合したコードテンプレートを解説する。'
pubDate: '2026-09-19'
category: 'infra'
tags: ['Ansible', 'Terraform', 'IaC', 'テンプレート', 'Docker']
seriesId: 'ansible-terraform-part1'
seriesNo: 10
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09/'
nextPost: ''
relatedSeries: ''
---


<style>
table th,
table td {
    word-break: normal;
}
table td:first-child {
    white-space: nowrap;
}
</style>


---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第1部まとめブログ：環境構築・連携編で直面する9つのトラブル** **※近日公開予定**

---

## 目次

1. [はじめに](#1-はじめに)
2. [第1〜9回のトラブルと解決策の総括](#2-第19回のトラブルと解決策の総括)
3. [TerraformからAnsibleへの安全な実行順序](#3-terraformからansibleへの安全な実行順序)
4. [Terraform側のテンプレート構成](#4-terraform側のテンプレート構成)
5. [Ansible側のテンプレート構成](#5-ansible側のテンプレート構成)
6. [まとめ](#6-まとめ)
7. [次回予告](#7-次回予告)
8. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#8-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

第1回から第9回にかけて、TerraformとAnsibleを連携させる際に、環境構築の段階で直面するトラブルを一つずつ扱ってきました。SSH接続のタイミング、インベントリの形式、鍵のパーミッション、IPアドレスの変動、ネットワークの初期化、Pythonバージョンの不一致、並列処理の競合、権限昇格の設定ミス。これらは個別に見ると独立した問題ですが、いずれも「Terraformでリソースを生成してから、Ansibleが構成管理を始めるまで」という同じ区間で発生する問題です。

第1回で整理した通り、この区間でトラブルが起きる根本には、AnsibleとTerraformがそれぞれ独立したツールとして動いており、片方の完了報告がもう片方にとって「安全に始めてよい」という保証にはならない、という構造があります。第2回から第9回で見てきた個別のトラブルは、この構造がさまざまな形で表面化したものでした。

この回では、第1回から第9回で得られた解決策を振り返り、それらを個別の対処としてではなく、TerraformからAnsibleへ一貫して安全に処理を移譲するための、一つの実行順序とコードテンプレートとして体系化します。

---

[↑ 目次に戻る](#目次)

---

## 2. 第1〜9回のトラブルと解決策の総括

第1回から第9回で扱ったトラブルと、それぞれの解決策を対応表で整理します。

|回|トラブル|解決策|
|---|---|---|
|**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-01/)**|Terraformの管理範囲とAnsibleの管理範囲を意識しない設計|リソース生成とOS内部の構成管理という役割の境界を分離する|
|**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-02/)**|TerraformのAPIレスポンスとSSHD起動完了の間のタイムラグによる接続失敗|`wait_for_connection`または`remote-exec`による接続確立ベースの待機制御を行う|
|**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-03/)**|TerraformのJSON出力とAnsibleが期待する動的インベントリのスキーマの違いによる「静かな失敗」|`all.hosts`・`_meta.hostvars`の形式に変換する動的インベントリスクリプトを用意する|
|**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-04/)**|Terraformが自動生成した秘密鍵ファイルのパーミッションがSSHクライアントの要件を満たさない|`file_permission`属性、または`chmod`によってパーミッションを`0600`に設定する|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-05/)**|リソース再生成に伴うIPアドレス変動により、Ansibleの接続先とインベントリが不一致になる|TerraformリソースレベルでのIP固定、または動的インベントリによる都度取得のいずれかで一致させ続ける|
|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-06/)**|ネットワーク自体の初期化完了前に接続を試み、SSH接続がタイムアウトする|`wait_for`モジュールによるポート疎通確認を待機する|
|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07/)**|Terraformがプロビジョニングするコンテナ・VMのPythonバージョンが固定されず、Ansibleモジュールが実行時エラーになる|Terraformが参照するイメージのビルド定義でPythonバージョンを明示的に固定する|
|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-08/)**|TerraformのparallelismとAnsibleのforksという独立した並列度がズレ、処理が遅延・競合する|`-parallelism`と`forks`の値を意識して揃える|
|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09/)**|コンテナイメージごとに異なるデフォルトユーザーに対し、`ansible_user`・become設定がずれる|インベントリ・group_varsでコンテナごとに正しく指定し、必要に応じてTerraformのプロビジョニングでsudoers設定を行う|

この総括から見えてくるのは、第1〜9回のトラブルが、大きく3つの性質に分かれるという点です。

1つ目は、**「完了」と「使える状態」のタイミングのズレ**です。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-02/)** ・**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-06/)** がこれにあたります。Terraformが完了を報告する基準と、実際にAnsibleが接続できる状態になる基準が異なるために起こる問題でした。

2つ目は、**「Terraformが管理する情報の形式」と「Ansibleが必要とする情報の形式」の不一致**です。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-03/)** ・ **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-05/)** がこれにあたります。Terraformが持っている情報自体は正しくても、Ansible側がそれをそのまま使える形になっているとは限らない、という問題でした。

3つ目は、**「Terraformが管理する土台の中身」がAnsibleの前提と食い違うことによる実行時エラー**です。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-04/)** ・ **[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07/)** ・**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09/)** がこれにあたります。Terraformが生成するリソースの中身(パーミッション、Pythonバージョン、デフォルトユーザー)を、Terraform自身は管理範囲としていないために起こる問題でした。

**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-08/)** の並列処理の競合は、この3分類のいずれとも性質が異なり、TerraformとAnsibleがそれぞれ独立に持つ並列度の設定が噛み合わないという、実行効率に関わる問題でした。

次のセクションでは、これらの解決策を踏まえ、TerraformからAnsibleへ安全に処理を移譲するための実行順序を整理します。

---

[↑ 目次に戻る](#目次)

---

## 3. TerraformからAnsibleへの安全な実行順序

第1〜9回の解決策を踏まえ、TerraformからAnsibleへ安全に処理を移譲するための実行順序を整理します。

```
Terraformがネットワークリソースを生成する
　↓
Terraformがコンテナ（またはVM）を生成する
　↓
Terraformが秘密鍵を出力し、パーミッションを0600に設定する
　↓
Terraformがコンテナの状態（IPアドレス等）をtfstateに記録する
　↓
Ansible側で接続先の情報を取得する（動的インベントリ、またはTerraformの出力を変換したインベントリファイル）
　↓
Ansible側でSSH接続・ネットワーク疎通の確立を待機する
　↓
Ansible側で正しいPythonインタプリタを使用する
　↓
Ansible側でコンテナごとに正しいansible_user・become設定を適用する
　↓
Playbookのタスクを実行する
```

この順序が、第1〜9回のトラブルにどう対応しているかを整理します。

- 秘密鍵のパーミッション設定(**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-04/)**)は、Terraform側でリソースを生成する段階に組み込まれています
- 接続先情報の取得( **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-03/)** ・ **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-05/)**)は、IPアドレスがTerraformの管理下で変動しうることを前提に、Ansible側で都度正しく解決する段階として位置づけています
- SSH接続・ネットワーク疎通の待機(**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-02/)** ・ **[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-06/)**)は、「リソースが生成された」ことと「実際に使える状態になった」ことが別のタイミングであるという構造を踏まえ、Ansible側の実行の直前に置いています
- Pythonインタプリタの指定(**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07/)**)、ansible_user・become設定(**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09/)**)は、いずれもAnsibleがタスクを実行する直前の、接続確立後の設定として位置づけています

この実行順序で意識しているのは、**「Terraformが生成完了と報告すること」と「Ansibleがそのリソースに対して安全に作業を始められること」は別の基準である**、という **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-01/)** 以来の考え方です。この順序を守ることで、第2〜9回で見てきた個別のトラブルの多くを、事前に回避できる構成になります。

なお、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-08/)** で扱った並列処理の競合(parallelismとforksのズレ)は、この実行順序そのものというより、リソース数が増えた場合に意識すべき調整項目という性質のため、この順序図には含めていません。

VM環境・クラウド環境でも、リソースの実装方式が変わるだけで、この基本的な順序自体は同じ考え方が適用できます。

---

[↑ 目次に戻る](#目次)

---

## 4. Terraform側のテンプレート構成

第1〜9回の解決策のうち、Terraform側で対応する要素を統合したテンプレート構成を示します。

```hcl
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.9"
    }
  }
}

provider "docker" {}

# 検証用ネットワークの作成（第5回：固定IPで再生成時の変動を防ぐ）
resource "docker_network" "lab_net" {
  name = "ansible-lab-net"
  ipam_config {
    subnet  = "172.20.0.0/24"
    gateway = "172.20.0.1"
  }
}

locals {
  target_nodes = {
    "target-node1" = 2221
    "target-node2" = 2222
    "target-node3" = 2223
  }
  target_ips = {
    "target-node1" = "172.20.0.11"
    "target-node2" = "172.20.0.12"
    "target-node3" = "172.20.0.13"
  }
}

# コンテナイメージのビルド（第7回：Pythonバージョンを明示的に固定したDockerfileを参照）
resource "docker_image" "ansible_target" {
  name = "ansible-target:ubuntu22.04"
  build {
    context    = "."
    dockerfile = "Dockerfile"
  }
}

# コンテナの作成・起動
resource "docker_container" "targets" {
  for_each = local.target_nodes
  name     = each.key
  image    = docker_image.ansible_target.image_id

  networks_advanced {
    name         = docker_network.lab_net.name
    ipv4_address = local.target_ips[each.key]
  }

  ports {
    internal = 22
    external = each.value
  }

  upload {
    file    = "/home/ansible/.ssh/authorized_keys"
    content = "${file("${path.module}/id_ed25519.pub")}\n${tls_private_key.generated.public_key_openssh}"
  }
}

# 秘密鍵の生成とパーミッション設定（第4回）
resource "tls_private_key" "generated" {
  algorithm = "ED25519"
}

resource "local_file" "private_key" {
  filename        = "${path.module}/id_ed25519_generated"
  content         = tls_private_key.generated.private_key_openssh
  file_permission = "0600"
}

# ネットワーク初期化の最小限の待機（第6回）
resource "time_sleep" "wait_for_network" {
  depends_on      = [docker_network.lab_net]
  create_duration = "10s"
}

output "target_nodes_ips" {
  value = {
    for name, container in docker_container.targets :
    name => container.network_data[0].ip_address
  }
  description = "Internal IP addresses for target nodes"
}

resource "local_file" "ansible_inventory" {
  filename = "${path.module}/inventory.ini"
  content = templatefile("${path.module}/inventory.tftpl", {
    ips = {
      for name, container in docker_container.targets :
      name => container.network_data[0].ip_address
    }
  })
}

# Terraform側での接続確立待機とAnsible実行（第2回・第8回）
resource "null_resource" "provision" {
  depends_on = [
    time_sleep.wait_for_network,
    local_file.ansible_inventory,
    local_file.private_key
  ]

  connection {
    type        = "ssh"
    host        = docker_container.targets["target-node1"].network_data[0].ip_address
    user        = "ansible"
    private_key = tls_private_key.generated.private_key_openssh
  }

  provisioner "remote-exec" {
    inline = ["echo 'SSH接続確認'"]
  }

  provisioner "local-exec" {
    command = "ansible-playbook -i inventory.ini site.yml -e ansible_python_interpreter=/usr/bin/python3.10 --forks=5"
  }
}
```

各要素と、対応する回を整理します。

|要素|対応する回|
|---|---|
|`docker_network.lab_net`の`ipam_config`|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-05/)** :リソースレベルでのIP固定|
|`Dockerfile`によるPythonバージョンの明示指定|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07/)** :Terraformプロビジョニングでのバージョン統一|
|`local_file.private_key`の`file_permission`属性|**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-04/)** :パーミッションの明示指定|
|`time_sleep.wait_for_network`|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-06/)** :ネットワーク初期化の最小限の待機|
|`null_resource.provision`内の`remote-exec`|**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-02/)** :SSH接続確立を条件にした待機|
|`local-exec`内の`--forks=5`|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-08/)** :Ansible側の並列度指定|

このテンプレートで意識しているのは、第3節で整理した実行順序をそのままHCLに落とし込むことです。ネットワークが最小限待機された後、SSH接続の確立が`remote-exec`で確認されてから、初めて`local-exec`でAnsibleが呼び出されます。この時点で秘密鍵のパーミッションはすでに`0600`に設定済みであり、接続先のIPアドレスは固定されているため、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-05/)** で扱ったインベントリとの不一致も起こりません。

第9回で扱った`ansible_user`・become設定は、Terraform側ではなくAnsible側(インベントリ・group_vars)で扱う内容のため、次のセクションで整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. Ansible側のテンプレート構成

第1〜9回の解決策のうち、Ansible側で対応する要素を統合したテンプレート構成を示します。

**動的インベントリスクリプト(第3回)**

```python
#!/usr/bin/env python3
import argparse
import json
import subprocess


def get_terraform_output():
    result = subprocess.run(
        ["terraform", "output", "-json", "target_nodes_ips"],
        capture_output=True, text=True, check=True
    )
    return json.loads(result.stdout)


def build_inventory():
    nodes = get_terraform_output()
    return {
        "all": {
            "hosts": list(nodes.keys()),
            "vars": {}
        },
        "_meta": {
            "hostvars": {
                name: {
                    "ansible_host": ip,
                    "ansible_user": "ansible",
                    "ansible_python_interpreter": "/usr/bin/python3.10",
                    "ansible_become": True,
                    "ansible_become_user": "root"
                }
                for name, ip in nodes.items()
            }
        }
    }


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list", action="store_true")
    group.add_argument("--host")
    args = parser.parse_args()

    if args.list:
        print(json.dumps(build_inventory()))
    else:
        print(json.dumps({}))


if __name__ == "__main__":
    main()
```

**[第3回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-03)** のスクリプトに対し、`_meta.hostvars`へ`ansible_python_interpreter`(**[第7回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07)**)・`ansible_become`・`ansible_become_user`(**[第9回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09)**)を追加しています。コンテナごとにユーザーやPythonバージョンが異なる場合は、`nodes.items()`のループ内で条件分岐させ、ホストごとに異なる値を設定する形に拡張できます。

**group_varsでの設定([第9回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09))**

```yaml
# group_vars/target_nodes.yml
ansible_become: true
ansible_become_user: root
ansible_python_interpreter: /usr/bin/python3.10
```

動的インベントリスクリプト側で`hostvars`に含めず、group_vars側にまとめる場合はこちらの形になります。どちらか一方に統一し、二重に定義しないようにします。

**ansible.cfg([第8回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-08))**

```ini
[defaults]
host_key_checking = False
private_key_file = ~/.ssh/id_ed25519_generated
forks = 5
```

`forks`をTerraform側の`-parallelism`(セクション4で`local-exec`実行時に`--forks=5`を指定)と揃えています。

**Playbook冒頭の接続確立待機([第2回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-02) ・ [第6回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-06))**

```yaml
---
- name: 環境構築後の初期構成
  hosts: target_nodes
  gather_facts: false

  tasks:
    - name: ネットワーク疎通を待機する
      ansible.builtin.wait_for:
        host: "{{ ansible_host }}"
        port: 22
        timeout: 120

    - name: SSHDの起動を待機する
      ansible.builtin.wait_for_connection:
        timeout: 120

    - name: 疎通確認
      ansible.builtin.ping:

    - name: 以降の構成タスク
      # ...
```

`wait_for`(ネットワーク疎通、**[第6回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-06)**)と`wait_for_connection`(SSHD起動、**[第2回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-02)**)は、**[第6回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-06)** セクション5で整理した通り確認している対象が異なるため、両方を冒頭に置いています。`wait_for`でネットワーク経路の確立を確認したうえで、`wait_for_connection`でSSHDが実際に応答できる状態かを確認する、という2段階の待機です。

各要素と対応する回を整理します。

|要素|対応する回|
|---|---|
|動的インベントリスクリプトの`_meta.hostvars`|**[第3回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-03)** (基本構造) ・ **[第7回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07)** (python_interpreter)・ **[第9回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09)** (become設定)|
|group_vars|**[第9回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09)**|
|`ansible.cfg`の`forks`|**[第8回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-08)**|
|`wait_for`|**[第6回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-06)**|
|`wait_for_connection`|**[第2回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-02)**|

このテンプレートで意識しているのは、Ansible側が「接続先の情報をどこから得るか」(動的インベントリ)と、「接続してから何を確認し、どう振る舞うか」(疎通待機・Python・become)を、それぞれ役割ごとに分けて設定する構成です。第9回で見た通り、`ansible_user`とコンテナの実際のユーザーが一致していなければ、この構成のどこにも到達する前にSSH接続自体が失敗します。動的インベントリの`hostvars`にホストごとの`ansible_user`を正しく持たせることが、この構成全体の前提になります。

---

[↑ 目次に戻る](#目次)

---

## 6. まとめ

この回で整理した内容を確認します。

* **[第1回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-01)** から **[第9回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09)** で扱ったトラブルは、いずれも「Terraformでリソースを生成してから、Ansibleが構成管理を始めるまで」という区間で発生する問題でした。個別には独立した問題に見えますが、「完了報告と使える状態のタイミングのズレ」「Terraformが管理する情報の形式とAnsibleが必要とする形式の不一致」「Terraformが管理する土台の中身がAnsibleの前提と食い違うこと」という3つの性質に整理できます
* TerraformからAnsibleへ安全に処理を移譲するための実行順序は、「リソース生成→秘密鍵のパーミッション設定→ネットワーク・接続確立の待機→正しいPythonインタプリタの使用→コンテナごとの正しいansible_user・become設定→タスク実行」という流れに整理できます。この順序は、Terraformが完了を報告することと、Ansibleが安全に作業を始められることが別の基準であるという、**[第1回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-01)** 以来の考え方に基づいています
* Terraform側のテンプレートでは、IPアドレスの固定(第5回)・Pythonバージョンの明示指定(**[第7回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07)**)・秘密鍵のパーミッション設定(**[第4回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-04)**)・ネットワーク初期化の最小限の待機(**[第6回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-06)**)・SSH接続確立の確認(**[第2回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-02)**)を、リソース生成から`local-exec`によるAnsible実行までの一連の流れに組み込みました
* Ansible側のテンプレートでは、動的インベントリスクリプトによる接続情報の取得(第3回)に、Pythonインタプリタ(**[第7回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07)**)・become設定(**[第9回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09)**)を組み込み、`ansible.cfg`のforks調整(第8回)と、Playbook冒頭でのネットワーク疎通・SSHD起動の2段階の待機(**[第6回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-06)** ・ **[第2回](http://localhost:4321/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-02)** )を組み合わせました
* このテンプレートはDocker環境での検証を基本としていますが、VM・クラウド環境でも、リソースの実装方式が変わるだけで同じ考え方が適用できます

第1部を通じて一貫していたのは、TerraformとAnsibleがそれぞれ独立したツールであり、片方の完了報告がもう片方にとって「安全に始めてよい」という保証にはならない、という構造でした。このテンプレートは、その構造を踏まえたうえで、両者の間にある9つの落とし穴をあらかじめ塞ぐための土台です。

---

[↑ 目次に戻る](#-目次)

---

## 7. 次回予告

第1部(第1〜10回)では、Terraformでリソースを生成してからAnsibleが構成管理を始めるまでの、環境構築・連携時のトラブルを扱ってきました。第2部(第11〜20回)からは、視点が「構築時」から「構築後の継続運用」に移ります。

第11回では、構築後に手動やAnsibleで変更したOS内部の状態を、Terraformの`plan`が検知できず、インフラの管理状態に不整合が生じる問題を取り上げます。ドリフトシリーズで扱った内容が、Ansible×Terraform環境でどのように現れるかを見ていきます。

**次回：第11回：手動変更による構成ドリフトの検知と同期手法**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09/)　｜　次の記事：【Ansible×Terraform編】第11回**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第1部まとめブログ：環境構築・連携編で直面する9つのトラブル** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 8. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第1部：環境構築・連携編

|回数|テーマ・記事タイトル|概要|
|---|---|---|
|**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-01/)**|AnsibleとTerraformの連携目的と設計思想の違い|リソース生成（Terraform）と構成管理（Ansible）の役割分担と、連携時における設計のアンチパターンを俯瞰。冪等性シリーズ・ドリフトシリーズとの接続を示す。|
|**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-02/)**|Terraform完了直後のプロビジョニング失敗を防ぐSSH待機制御|TerraformのAPIレスポンスとSSHDが接続を受け付けられる状態になるまでのタイムラグによる接続失敗と解決策。VM環境（EC2・VirtualBox）でのOSブート待ち・Docker環境でのSSHD初期化待ちなど、環境を問わず発生する構造として示す。|
|**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-03/)**|動的インベントリ生成時における出力データのパースエラー|TerraformのJSON出力とAnsibleが期待する動的インベントリのJSONスキーマの構造的な差異を整理し、生の出力をそのまま渡した際の「静かな失敗」を実機再現したうえで、変換スクリプトによる解決方法を解説する。|
|**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-04/)**|自動生成されたSSH鍵のパーミッション設定エラー|Terraformで自動生成した秘密鍵ファイルの権限設定が不適切なため、AnsibleのSSH実行時に接続を拒否されるトラブルへの対応。|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-05/)**|仮想環境におけるIPアドレス変動対策|Terraformのリソース再生成で発生するIPアドレス変動を実機検証する。applyとAnsible実行のタイミングが分離すると、SSH接続自体は成功するのに意図しないホストへ接続する危険があることを示し、IP固定と動的インベントリという2つの解決アプローチを比較する。|
|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-06/)**|ネットワーク初期化完了前に発生する接続タイムアウト|ネットワーク構築完了直後にAnsibleが接続を試み、反映待ちでSSH接続がタイムアウトする問題。Dockerネットワークのブリッジ・AWSのSecurity Group・VPCルーターの伝播ラグなど、実装方式が違っても「構築完了」と「通信可能」が別タイミングである共通構造から生じることを整理し、対策を解説する。|
|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07/)**|実行環境とターゲットOS間におけるPythonバージョンの不一致|ターゲットOS内のPythonバージョンと、Ansibleを実行するコントロールノード側のPythonの乖離による実行時エラーへの対応。冪等性シリーズ第7回との接続を示す。|
|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-08/)**|複数インスタンス同時構築時における並列処理の競合|Terraformで複数リソースを同時生成する際、Ansible側のforks制限によって処理が遅延・競合しうる問題。同時生成数が実行環境のキャパシティに対して相対的に多い場合に起こる構造的な問題として整理し、forks調整やバッチ分割の対策を解説する。|
|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09/)**|OS固有の初期ユーザーと管理者権限（sudo）への昇格エラー|コンテナイメージごとに異なるデフォルトユーザーに対し、Ansibleから`become`を用いて権限昇格する際の設定ミスと対策。Docker・VM・クラウドを問わず同じ構造で発生することを示す。|
|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-10/)**|環境構築編まとめ：自動連携のためのコードテンプレート化|第1回〜9回の課題を踏まえ、TerraformからAnsibleへ一貫して安全に処理を移譲するためのコードのテンプレート化を解説。|
---

---

[↑ 目次に戻る](#目次)

---
