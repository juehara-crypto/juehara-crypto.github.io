---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第22回：マルチネットワーク環境におけるインターフェース競合'
description: 'Terraformで複数のDockerネットワークをコンテナにアタッチした際、HCL上の記述順序とコンテナ内部で実際に割り当てられるインターフェース名の対応関係が一致しない構造を整理する。この順序のずれがAnsibleの接続先IP自動検出（ansible_default_ipv4等）に波及し、接続エラーの原因となる仕組みと対処を扱う。'
pubDate: 2026-08-31
category: 'infra'
tags: ['Ansible', 'Terraform', 'Docker', 'ネットワーク', 'デバッグ']
seriesId: 'ansible-terraform-part3'
seriesNo: 22
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/'
relatedSeries: ''
---


<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [Terraform側での複数ネットワーク定義](#2-terraform側での複数ネットワーク定義)
3. [コンテナ内部でのインターフェース割り当ての仕組み](#3-コンテナ内部でのインターフェース割り当ての仕組み)
4. [Ansible接続時の自動検出への影響](#4-ansible接続時の自動検出への影響)
5. [経路の確認、切り分け手順](#5-経路の確認切り分け手順)
6. [接続順序の制御による対処](#6-接続順序の制御による対処)
7. [検証環境と他環境との共通性](#7-検証環境と他環境との共通性)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#10-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「AnsibleがSSH接続に失敗するのは、ファイアウォールかSSH鍵の問題だろう」と考えたことはないでしょうか。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** では、`local-exec`経由でAnsibleを実行した際にエラーログがどう変質するか、そしてTerraform側の出力とAnsible側の出力をどう突き合わせて原因を特定するかという、ログ解析の手法を扱いました。この手法は、原因が何であれ共通して使える土台であるという位置づけでした。

**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** では、その手法を使って実際に原因を特定する対象となる事象の一つを扱います。複数のネットワークをコンテナにアタッチした環境で発生する、Ansible接続の失敗です。

原因の起点はTerraform側にあります。`docker_container`リソースに複数の`networks_advanced`ブロックを記述しても、コンテナ内部でどちらが`eth0`になりどちらが`eth1`になるかは、HCL上の記述順序では決まりません。この順序のずれは、Ansible側で接続先IPを自動検出する設定（`ansible_default_ipv4`等）を使っている場合、そのまま接続失敗に直結します。

この回で扱う問いは、「Terraformでのネットワーク定義が、コンテナ内部、そしてAnsible側にどう波及するのか」です。

次のセクションでは、この問いの起点となる、Terraform側での複数ネットワーク定義そのものを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. Terraform側での複数ネットワーク定義

この回の起点となる構造を確認します。`docker_container`リソースに複数の`networks_advanced`ブロックを記述した場合、その記述順序が、コンテナ内部でのインターフェース割り当てにそのまま反映されるとは限りません。この点を実機で確認します。

`target-node1`に、既存の`lab_net`に加えて`app_net`という2つ目のネットワークをアタッチします。

* **ファイル名：**`main.tf`（該当箇所）
```hcl
resource "docker_network" "lab_net" {
  name = "ansible-lab-net"
}
resource "docker_network" "app_net" {
  name = "ansible-app-net"
}
# 3. ノードごとの定義 map（名前と外部SSHポート）
locals {
  target_nodes = {
    "target-node1" = 2231
    "target-node2" = 2222
    "target-node3" = 2223
  }
  target_node_networks = {
    "target-node1" = [docker_network.lab_net.name, docker_network.app_net.name]
    "target-node2" = [docker_network.lab_net.name]
    "target-node3" = [docker_network.lab_net.name]
  }
}
# 4. コンテナの作成・起動（for_eachで一括生成、target-node1のみ複数ネットワークをアタッチ）
resource "docker_container" "targets" {
  for_each = local.target_nodes
  name  = each.key
  image = docker_image.ansible_target.image_id
  dynamic "networks_advanced" {
    for_each = local.target_node_networks[each.key]
    content {
      name = networks_advanced.value
    }
  }
  ports {
```

`target-node1`に対しては`lab_net`を先、`app_net`を後という順序で記述しています。

### ■ 検証内容：複数ネットワークアタッチ後のインターフェース割り当て確認

上記の変更を適用し、`target-node1`のコンテナ内部で実際に割り当てられたインターフェースを確認します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
(ansible-env) control@ubuntu-controller:~/iac/docker-lab$ terraform apply
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
docker_network.app_net: Refreshing state... [id=54f7b73fd1625642a3ef6ed67fbde6f93062353422a9afeced223cd940c4c5ca]
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node3"]: Refreshing state... [id=acac4b63e617b41bcb7b9f7126a58bd49c20a9e8fa4d95bf9118c088b5306fcd]
docker_container.targets["target-node2"]: Refreshing state... [id=a33463336b78be7e1b09cfef85e2b18e4cbdcdb4d7f43087e344e8fa6cb62743]

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] will be created
  + resource "docker_container" "targets" {
      + attach                                      = false
      + bridge                                      = (known after apply)
      + command                                     = (known after apply)
      + container_logs                              = (known after apply)
      + container_read_refresh_timeout_milliseconds = 15000
      + entrypoint                                  = (known after apply)
      + env                                         = (known after apply)
      + exit_code                                   = (known after apply)
      + hostname                                    = (known after apply)
      + id                                          = (known after apply)
      + image                                       = "sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30"
      + init                                        = (known after apply)
      + ipc_mode                                    = (known after apply)
      + log_driver                                  = (known after apply)
      + logs                                        = false
      + must_run                                    = true
      + name                                        = "target-node1"
      + network_data                                = (known after apply)
      + read_only                                   = false
      + remove_volumes                              = true
      + restart                                     = "no"
      + rm                                          = false
      + runtime                                     = (known after apply)
      + security_opts                               = (known after apply)
      + shm_size                                    = (known after apply)
      + start                                       = true
      + stdin_open                                  = false
      + stop_signal                                 = (known after apply)
      + stop_timeout                                = (known after apply)
      + tty                                         = false
      + wait                                        = false
      + wait_timeout                                = 60

      + healthcheck (known after apply)

      + labels (known after apply)

      + networks_advanced {
          + aliases      = []
          + name         = "ansible-app-net"
            # (2 unchanged attributes hidden)
        }
      + networks_advanced {
          + aliases      = []
          + name         = "ansible-lab-net"
            # (2 unchanged attributes hidden)
        }

      + ports {
          + external = 2231
          + internal = 22
          + ip       = "0.0.0.0"
          + protocol = "tcp"
        }

      + upload {
          + content        = <<-EOT
                init_version=v1
            EOT
          + executable     = false
          + file           = "/etc/init_marker"
            # (3 unchanged attributes hidden)
        }
      + upload {
          + content        = <<-EOT
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ9ZflEAp+DdFuvvm/+Y7HhfCtg0n51gm5xN4IfNH9aM control@ubuntu-controller

                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBNq1AJD66jrCFzItazhDFMeajO6eQmK6S5Eb//xB8aB
            EOT
          + executable     = false
          + file           = "/home/ansible/.ssh/authorized_keys"
            # (3 unchanged attributes hidden)
        }
    }

  # local_file.ansible_inventory will be created
  + resource "local_file" "ansible_inventory" {
      + content              = (known after apply)
      + content_base64sha256 = (known after apply)
      + content_base64sha512 = (known after apply)
      + content_md5          = (known after apply)
      + content_sha1         = (known after apply)
      + content_sha256       = (known after apply)
      + content_sha512       = (known after apply)
      + directory_permission = "0777"
      + file_permission      = "0777"
      + filename             = "./inventory.ini"
      + id                   = (known after apply)
    }

  # null_resource.provision will be created
  + resource "null_resource" "provision" {
      + id = (known after apply)
    }

Plan: 3 to add, 0 to change, 0 to destroy.

Changes to Outputs:
  ~ target_nodes_ips = {
      ~ target-node1 = "172.18.0.2" -> (known after apply)
        # (2 unchanged attributes hidden)
    }

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node1"]: Creation complete after 3s [id=cd4aa4face014742f05dd5102d08c9c0145ff60d8c65af74d5547af38ac4d40e]
local_file.ansible_inventory: Creating...
local_file.ansible_inventory: Creation complete after 0s [id=3ded465751ae7883faf871c4895d1c5d735723c3]
null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/ansible-run.log ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_normal.yml"]

null_resource.provision (local-exec): PLAY [local-execログ構造デモ（正常系）] ****************************************

null_resource.provision (local-exec): TASK [検証用ディレクトリを作成する] ********************************************
null_resource.provision (local-exec): [WARNING]: Platform linux on host target-node1 is using the discovered Python
null_resource.provision (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.provision (local-exec): interpreter could change the meaning of that path. See
null_resource.provision (local-exec): https://docs.ansible.com/ansible-
null_resource.provision (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.provision (local-exec): changed: [target-node1]

null_resource.provision (local-exec): TASK [検証用設定ファイルを配置する] ********************************************
null_resource.provision (local-exec): changed: [target-node1]

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

null_resource.provision: Creation complete after 3s [id=7457233514236216081]

Apply complete! Resources: 3 added, 0 changed, 0 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.18.0.2"
  "target-node2" = "172.20.0.2"
  "target-node3" = "172.20.0.3"
}
```

続けて、`target-node1`のコンテナ内部で実際に割り当てられたインターフェースを確認します。

**実行コマンド**

```plaintext
docker exec target-node1 ip addr
```

**▼ 実行結果**
```plaintext
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
    inet6 ::1/128 scope host
       valid_lft forever preferred_lft forever
2: eth0@if15: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default
    link/ether 0a:a1:17:d8:10:9e brd ff:ff:ff:ff:ff:ff link-netnsid 0
    inet 172.18.0.2/16 brd 172.18.255.255 scope global eth0
       valid_lft forever preferred_lft forever
3: eth1@if16: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default
    link/ether ea:a4:f5:58:d6:45 brd ff:ff:ff:ff:ff:ff link-netnsid 0
    inet 172.20.0.4/24 brd 172.20.0.255 scope global eth1
       valid_lft forever preferred_lft forever
```

### ■ 結果

コンテナ内部を確認すると、`eth0`には`172.18.0.2/16`が割り当てられています。これは`app_net`（`ansible-app-net`）側のIPアドレスです。一方`eth1`には`172.20.0.4/24`が割り当てられており、こちらは`lab_net`（`ansible-lab-net`）側のIPアドレスです。

HCL上で先に記述した`lab_net`が`eth1`となり、後に記述した`app_net`が`eth0`となりました。記述順序と、コンテナ内部でのインターフェース番号の対応は、想定とは逆になっています。この結果から、HCL上の記述順序が、そのままコンテナ内部でのインターフェース割り当て順序に反映されるわけではないことが確認できました。

なぜこの逆転が起きるのかについては、次のセクションで整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. コンテナ内部でのインターフェース割り当ての仕組み

前セクションで、HCL上の記述順序（`lab_net`を先、`app_net`を後）と、コンテナ内部でのインターフェース割り当て（`eth0`が`app_net`、`eth1`が`lab_net`）が逆転していることを確認しました。このセクションでは、なぜこの逆転が起きるのかを整理します。

コンテナ内部でのインターフェース番号は、コンテナ起動時に最初に接続されたネットワークが`eth0`、その後接続されたネットワークが`eth1`、`eth2`と連番で割り当てられます。この割り当ては、HCL上の記述順序ではなく、Dockerデーモンへのネットワーク接続処理が実行された順序に依存します。

### ■ 検証内容：Dockerデーモンのネットワーク接続順序の確認

Dockerデーモンのログから、`target-node1`が実際にどちらのネットワークへ先に接続されたかを確認します。

**実行コマンド**

```plaintext
sudo journalctl -u docker --since "60 minutes ago" | grep -i "target-node1\|ansible-app-net\|ansible-lab-net"
```

**▼ 実行結果**

```plaintext
Aug 25 00:32:11 ubuntu-controller dockerd[766]: time="2026-08-25T00:32:11.369851310Z" level=info msg="sbJoin: gwep4 ''->'cf35579d66a9', gwep6 ''->''" eid=cf35579d66a9 ep=target-node1 net=ansible-app-net nid=54f7b73fd162
Aug 25 00:32:11 ubuntu-controller dockerd[766]: time="2026-08-25T00:32:11.555472794Z" level=info msg="sbJoin: gwep4 'cf35579d66a9'->'cf35579d66a9', gwep6 ''->''" eid=933a1d22a136 ep=target-node1 net=ansible-lab-net nid=261d153c5dc8
```

### ■ 結果

`sbJoin`のログから、`target-node1`がネットワークへ接続された時刻を確認できます。`ansible-app-net`への接続（`00:32:11.369851310`）が、`ansible-lab-net`への接続（`00:32:11.555472794`）よりも先に行われています。

HCL上では`lab_net`を先、`app_net`を後に記述していましたが、Dockerデーモンへの実際の接続処理は、記述順序とは逆に`app_net`が先でした。前セクションで確認した「`eth0`が`app_net`、`eth1`が`lab_net`」という割り当て結果は、このDockerデーモン側の接続順序と一致します。

つまり、コンテナ内部でのインターフェース番号は、HCL上の記述順序ではなく、Dockerデーモンが実際にネットワーク接続処理を実行した順序によって決まります。この処理順序は、Terraformが複数のリソースやブロックをどう処理するかに依存するため、HCLの見た目の記述順序だけからは予測できません。

次のセクションでは、この構造がAnsibleの接続先IP自動検出にどう影響するかを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 4. Ansible接続時の自動検出への影響

前セクションで確認した、コンテナ起動時に最初に接続されたネットワークが`eth0`になるという構造が、Ansibleの接続先IP自動検出にどう影響するかを確認します。

Ansibleが`ansible_host`を明示せず、接続先IPの自動検出（`ansible_default_ipv4`等のfacts）に依存している場合、コンテナ内部でどちらのネットワークがデフォルトルートとして扱われるかによって、Ansibleが参照するIPアドレス自体が変わります。この点を実機で確認します。

### ■ 検証内容：ansible_default_ipv4が返す値の確認

`target-node1`に対し、`setup`モジュールで`ansible_default_ipv4`のfactを取得します。

**実行コマンド**

```plaintext
ansible target-node1 -i inventory.ini -m setup -a "filter=ansible_default_ipv4"
```

**▼ 実行結果**

```plaintext
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
target-node1 | SUCCESS => {
    "ansible_facts": {
        "ansible_default_ipv4": {
            "address": "172.18.0.2",
            "alias": "eth0",
            "broadcast": "172.18.255.255",
            "gateway": "172.18.0.1",
            "interface": "eth0",
            "macaddress": "0a:a1:17:d8:10:9e",
            "mtu": 1500,
            "netmask": "255.255.0.0",
            "network": "172.18.0.0",
            "prefix": "16",
            "type": "ether"
        },
        "discovered_interpreter_python": "/usr/bin/python3.10"
    },
    "changed": false
}
```

### ■ 結果

`ansible_default_ipv4`は`172.18.0.2`、`interface`は`eth0`を返しています。前セクションで確認した通り、`eth0`は`app_net`側のインターフェースです。

つまり、`ansible_default_ipv4`というfactは、コンテナ内部でデフォルトルートとして扱われているインターフェース（今回は`eth0`＝`app_net`側）を指しており、これは前セクションで整理した「最初に接続されたネットワークが`eth0`になる」という構造をそのまま反映しています。もし`ansible_host`をこのfactに依存する設定（`ansible_host: "{{ ansible_default_ipv4.address }}"`）にしていた場合、Terraformの記述順序上は先に書いた`lab_net`ではなく、後から接続された`app_net`側に接続してしまうことになります。

なお、今回の検証環境では、静的インベントリ（`inventory.ini`）自体も`app_net`側のIPを`ansible_host`として持っていることが分かりました。

* **実行コマンド**

```plaintext
cat inventory.ini
```

* **▼ 実行結果**

```plaintext
[target_nodes]
target-node1 ansible_host=172.18.0.2 ansible_user=ansible
target-node2 ansible_host=172.20.0.2 ansible_user=ansible
target-node3 ansible_host=172.20.0.3 ansible_user=ansible
```

これは`ansible_default_ipv4`によるfacts自動検出とは別の経路で起きています。`main.tf`の`output "target_nodes_ips"`は`container.network_data[0].ip_address`という、Terraformが管理するネットワーク接続情報の配列の先頭要素を参照する定義になっており、この`network_data`の並び順もまた、HCLの記述順序ではなくDockerデーモンの接続順序に従います。

**実行コマンド**

```plaintext
terraform state show 'docker_container.targets["target-node1"]'
```

**▼ 実行結果**

```plaintext
# docker_container.targets["target-node1"]:
resource "docker_container" "targets" {
    attach                                      = false
    bridge                                      = null
    command                                     = [
        "/usr/sbin/sshd",
        "-D",
    ]
    container_read_refresh_timeout_milliseconds = 15000
    cpu_set                                     = null
    cpu_shares                                  = 0
    domainname                                  = null
    entrypoint                                  = []
    env                                         = []
    hostname                                    = "cd4aa4face01"
    id                                          = "cd4aa4face014742f05dd5102d08c9c0145ff60d8c65af74d5547af38ac4d40e"
    image                                       = "sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30"
    init                                        = false
    ipc_mode                                    = "private"
    log_driver                                  = "json-file"
    logs                                        = false
    max_retry_count                             = 0
    memory                                      = 0
    memory_swap                                 = 0
    must_run                                    = true
    name                                        = "target-node1"
    network_data                                = [
        {
            gateway                   = "172.18.0.1"
            global_ipv6_address       = null
            global_ipv6_prefix_length = 0
            ip_address                = "172.18.0.2"
            ip_prefix_length          = 16
            ipv6_gateway              = null
            mac_address               = "0a:a1:17:d8:10:9e"
            network_name              = "ansible-app-net"
        },
        {
            gateway                   = "172.20.0.1"
            global_ipv6_address       = null
            global_ipv6_prefix_length = 0
            ip_address                = "172.20.0.4"
            ip_prefix_length          = 24
            ipv6_gateway              = null
            mac_address               = "ea:a4:f5:58:d6:45"
            network_name              = "ansible-lab-net"
        },
    ]
    network_mode                                = "bridge"
    pid_mode                                    = null
    privileged                                  = false
    publish_all_ports                           = false
    read_only                                   = false
    remove_volumes                              = true
    restart                                     = "no"
    rm                                          = false
    runtime                                     = "runc"
    security_opts                               = []
    shm_size                                    = 64
    start                                       = true
    stdin_open                                  = false
    stop_signal                                 = null
    stop_timeout                                = 0
    tty                                         = false
    user                                        = null
    userns_mode                                 = null
    wait                                        = false
    wait_timeout                                = 60
    working_dir                                 = null

    networks_advanced {
        aliases      = []
        ipv4_address = null
        ipv6_address = null
        name         = "ansible-app-net"
    }
    networks_advanced {
        aliases      = []
        ipv4_address = null
        ipv6_address = null
        name         = "ansible-lab-net"
    }

    ports {
        external = 2231
        internal = 22
        ip       = "0.0.0.0"
        protocol = "tcp"
    }

    upload {
        content        = <<-EOT
            init_version=v1
        EOT
        content_base64 = null
        executable     = false
        file           = "/etc/init_marker"
        source         = null
        source_hash    = null
    }
    upload {
        content        = <<-EOT
            ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ9ZflEAp+DdFuvvm/+Y7HhfCtg0n51gm5xN4IfNH9aM control@ubuntu-controller

            ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBNq1AJD66jrCFzItazhDFMeajO6eQmK6S5Eb//xB8aB
        EOT
        content_base64 = null
        executable     = false
        file           = "/home/ansible/.ssh/authorized_keys"
        source         = null
        source_hash    = null
    }
}
```

`network_data[0]`は`network_name = "ansible-app-net"`、`ip_address = "172.18.0.2"`です。この配列の先頭を参照している`output`定義により、静的インベントリの`ansible_host`も`app_net`側のIPになっていました。

Ansibleのfacts自動検出（`ansible_default_ipv4`）と、Terraformの`output`定義（`network_data[0]`）は、それぞれ独立した仕組みです。しかし、どちらも「複数ネットワークのうち、最初に接続された（あるいは配列の先頭にある）ものを暗黙的に選ぶ」という共通の性質を持っているため、今回のようにDockerデーモンの接続順序がHCLの記述順序とずれている環境では、両方が同じネットワークを指す形で影響を受けます。

---

[↑ 目次に戻る](#-目次)

---

## 5. 経路の確認、切り分け手順

ここまでのセクションで、`main.tf`の記述順序、コンテナ内部のインターフェース割り当て、Ansibleのfacts自動検出、Terraformの`output`定義と、それぞれ個別に確認してきました。このセクションでは、実際にAnsibleの接続先が意図と異なる場合に、どの情報を確認すれば原因を特定できるかを、手順として整理します。

### ■ 検証内容：ip routeによるデフォルトルートの確認

`target-node1`のルーティングテーブルを確認します。

**実行コマンド**

```plaintext
docker exec target-node1 ip route
```

**▼ 実行結果**

```plaintext
default via 172.18.0.1 dev eth0
172.18.0.0/16 dev eth0 proto kernel scope link src 172.18.0.2
172.20.0.0/24 dev eth1 proto kernel scope link src 172.20.0.4
```

### ■ 結果

デフォルトルート（`default via 172.18.0.1 dev eth0`）は`eth0`経由、つまり`app_net`側になっています。セクション4で確認した`ansible_default_ipv4`が`172.18.0.2`（`eth0`）を返していたのは、このデフォルトルートの情報に基づくものであることが、`ip route`の出力から直接確認できます。

### 原因特定の手順

ここまでの検証を踏まえ、Ansibleの接続先が意図と異なる場合の切り分け手順を整理します。

**① コンテナ内で`ip addr`を実行し、実際に割り当てられたインターフェース名とIPアドレスを確認する**

どのインターフェースがどのネットワークに対応しているかを確認します（セクション2で実施）。

**② コンテナ内で`ip route`を実行し、デフォルトルートがどのインターフェース経由になっているかを確認する**

`ansible_default_ipv4`が返す値は、このデフォルトルートに基づきます（本セクションで実施）。

**③ Dockerデーモンのログで、実際のネットワーク接続順序を確認する**

`journalctl -u docker`の`sbJoin`ログから、どのネットワークが先に接続されたかを確認します（セクション3で実施）。

**④ Terraform側の`main.tf`・`terraform state show`で、HCL上の記述順序と実際の状態を突き合わせる**

`network_data`の並び順や、`output`定義がどの要素を参照しているかを確認します（セクション4で実施）。

この4つの情報を組み合わせることで、「なぜAnsibleが意図しないネットワークに接続してしまうのか」を、HCLの記述順序からコンテナ内部の実態まで一貫して追跡できます。

---

[↑ 目次に戻る](#-目次)

---

## 6. 接続順序の制御による対処

ここまでのセクションで確認した構造を踏まえ、対処パターンを整理します。Terraform側での対処と、Ansible側での対処、2つの方向性があります。

### Terraform側での対処の限界

複数の`networks_advanced`ブロックの接続順序を制御する方法として、`depends_on`を使う案が考えられます。しかし、`depends_on`はTerraformのメタ引数であり、リソース単位（またはモジュール単位）で「あるリソースが別のリソースに依存する」という関係を表すものです。同一リソース内に複数存在する`networks_advanced`のようなネストされたブロック同士の間で、どちらを先に処理するかを個別に指定する機能ではありません。

そのため、`docker_container.targets`リソースに`depends_on = [docker_network.lab_net]`のように追記しても、これは「`lab_net`というリソースが存在してからコンテナを作成する」ことを保証するだけであり、コンテナ作成時に`lab_net`と`app_net`のどちらへの接続処理が先に実行されるかという、ブロック単位の順序には影響しません。

単一の`apply`内で複数ネットワークを同時に定義する限り、HCL上の記述順序でこの接続順序を制御する手段は、現状のTerraform、Dockerプロバイダーの仕組み上ありません。

### Ansible側での対処

Terraform側で順序を制御できない以上、確実な対処はAnsible側にあります。`ansible_host`を自動検出（`ansible_default_ipv4`）に依存させず、インベントリで固定IPとして明示します。

### ■ 検証内容：固定IP明示によるインベントリでの接続確認

`target-node1`の`ansible_host`を、意図する`lab_net`側のIP（`172.20.0.4`）に固定して接続します。

- **ファイル名：**`inventory_fixed.ini`

```ini
[target_nodes]
target-node1 ansible_host=172.20.0.4 ansible_user=ansible
```

**実行コマンド**

```plaintext
ansible target-node1 -i inventory_fixed.ini -m ping
```

**▼ 実行結果**

```plaintext
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
target-node1 | SUCCESS => {
    "ansible_facts": {
        "discovered_interpreter_python": "/usr/bin/python3.10"
    },
    "changed": false,
    "ping": "pong"
}
```

### ■ 結果

`ansible_host`を`172.20.0.4`（`lab_net`側）に固定した状態で、`SUCCESS`、`"ping": "pong"`が返り、意図したネットワーク経由での接続が確認できました。

`ansible_default_ipv4`のような自動検出のfactsに頼らず、`ansible_host`をインベントリで明示的に指定することで、Dockerデーモンの接続順序やHCLの記述順序に関わらず、常に意図したネットワークへ接続できます。Terraform側の接続順序を制御しようとするより、Ansible側でこの依存を断つ方が確実な対処になります。

---

[↑ 目次に戻る](#-目次)

---

## 7. 検証環境と他環境との共通性

ここまで、Dockerコンテナ環境を使って、複数ネットワークのアタッチ時に発生するインターフェース割り当ての逆転と、それがAnsible接続に波及する構造を確認してきました。この構造がDocker固有のものではないことを整理します。

複数のネットワークインターフェースを持つリソースを構成する際、「インフラ定義上の記述順序」と「実行環境内部で実際に認識される順序」が一致しない、という構造自体は、実装方式が異なる環境でも共通して起こり得ます。

AWSでセカンダリENI（Elastic Network Interface）をアタッチする場合も、AWSのAPIがENIをアタッチする処理順序と、OS起動後にどのENIが`eth0`として認識されるかは、必ずしもTerraformのHCL上の記述順序とは一致しません。GCPで追加のネットワークインターフェースを構成する場合や、オンプレミス環境でKVMの仮想ネットワークを複数アタッチする場合も、同様にハイパーバイザーやAPIレベルでの接続処理順序に依存します。

いずれの環境でも、この問題への対処の方向性は今回整理した内容と同じです。インフラ定義側で接続順序を厳密に制御しようとするより、接続先を特定するアプリケーション側（今回はAnsible）で、自動検出に依存せず明示的な指定を行う方が確実な対処になります。

今回検証したDockerでのネットワーク接続順序のずれは、この構造の一例にすぎません。使用するプロバイダーやインフラの種類が変わっても、「定義上の順序」と「実行時に認識される順序」は別物であるという前提を持っておくことが、複数ネットワーク構成のトラブルシューティングにおいて共通して役立ちます。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

- `docker_container`リソースに複数の`networks_advanced`ブロックを記述しても、HCL上の記述順序がそのままコンテナ内部でのインターフェース割り当て順序（`eth0`、`eth1`）に反映されるとは限らない
- コンテナ内部でのインターフェース番号は、Dockerデーモンがネットワーク接続処理を実行した順序に依存する。この順序は`journalctl`の`sbJoin`ログから直接確認できる
- Ansibleの`ansible_default_ipv4`は、コンテナ内部のデフォルトルート（`ip route`で確認できる）に基づくfactである。デフォルトルートは最初に接続されたインターフェース側になりやすく、HCL上の記述順序とは無関係にこの値が決まる
- 静的インベントリを生成する`output`定義が`network_data[0]`のような配列の先頭要素を参照している場合、Ansibleのfacts自動検出とは別の経路で、同様に意図しないネットワークを指してしまうことがある
- `depends_on`はリソース単位の依存関係であり、同一リソース内の複数の`networks_advanced`ブロック間の接続順序を制御する機能ではない。Terraform側で接続順序を厳密に制御する手段は、現状の仕組み上ない
- 確実な対処は、`ansible_host`を自動検出に依存させず、インベントリで固定IPとして明示すること。これにより、Dockerデーモンの接続順序に関わらず、常に意図したネットワークへ接続できる
- この構造はDocker固有ではなく、AWSのセカンダリENI、GCPの追加ネットワークインターフェース、オンプレKVMのvirtual network等、環境が変わっても「インフラ定義の記述順序と、実行環境内部で実際に認識される順序が必ずしも一致しない」という構造自体は共通して発生する

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** では、`local-exec`経由でAnsibleを実行した際にエラーログがどう変質するかを整理し、ログの読み解き方という土台を扱いました。**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** となる今回は、その土台を使って実際に原因を特定する対象として、複数ネットワーク環境で発生する接続エラーを扱いました。HCL上の記述順序と、コンテナ内部で実際に認識される順序が一致しないこと、そしてAnsibleの接続先IP自動検出がこのずれの影響を受けることを、実機検証を交えて確認しました。

次回は、経路は正しく到達しているものの、大容量ファイル転送や重いタスクの実行時にSSHタイムアウトが発生する問題を扱います。TerraformのプロビジョナータイムアウトとAnsible側の処理時間の関係を整理します。

**[次回：第23回：大容量ファイル転送、重いタスク実行時におけるSSHタイムアウト](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)　｜　[次の記事：【Ansible×Terraform編】第23回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 10. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第3部：トラブルシューティング、デバッグ編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**|統合実行時におけるネストされたエラーログの解析手法|Terraformの`local-exec`経由で実行されたAnsibleのエラーログから、原因がTerraform側（HCL、State）かAnsible側（Playbook、タスク）かを特定する手法。|
|**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)**|マルチネットワーク環境におけるインターフェース競合|複数ネットワーク（Dockerネットワーク等）をアタッチした際、Ansibleの`ansible_default_ipv4`や接続IPの自動検出が意図しないインターフェースに引きずられる問題。|
|**[第23回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)**|大容量ファイル転送、重いタスク実行時におけるSSHタイムアウト|Ansibleで大きなアセットや大量のパッケージを転送、適用する際、Terraform側のプロビジョナータイムアウトに引っかかる可能性がある問題を扱う。|
|**[第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)**|並列実行時における実行ホストのシステムリソース枯渇対策|`parallelism`や`forks`設定により、大量のリソース構築とAnsibleプロビジョニングが同時に走った場合、ホストのCPU、メモリ、ファイルディスクリプタが枯渇しうる問題を扱う。|
|**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)**|構文チェックツール（HCL構文、ansible-lint）の競合緩和|両ツールの静的解析ツール（`terraform fmt`、`ansible-lint`）を導入した際、コード記述ルールや命名規則の不一致でCIが通らなくなる問題。|
|**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**|管理者権限（sudo）実行時におけるパスワード入力のプロンプト停止|Terraformのlocal-exec経由でAnsibleのbecomeを実行する際、パスワード入力を要求するオプションを指定した場合に限り、非対話実行環境で処理が無応答のまま停止する問題。|
|**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**|再起動、再生成に伴うプロビジョニング断絶|AnsibleのrebootモジュールによるOS再起動時、接続断絶が正常な過程か異常な停止かをTerraformのlocal-execが区別できず、外側のタイムアウトと競合する問題。|
|**[第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)**|異種OS（Windowsターゲット）混在環境における接続プロトコルの制約|SSHではなくWinRM等を用いる特殊プロトコル環境での接続、権限エラー。実務でWindows ServerをAnsible×Terraformで管理する際の構造的注意点を扱う概念解説回。|
|**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)**|プロキシ環境等における外部コレクション（Ansible Galaxy）の取得失敗|インフラ構築処理の途中で外部ネットワーク（Ansible Galaxy等）への依存が切れ、Terraformの処理全体が失敗する問題。|
|**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)**|デバッグフラグの組み合わせによるログ解析の高度化|Terraformの`TF_LOG`とAnsibleの`-vvvv`を組み合わせ、接続遅延や処理遅延のボトルネックを特定、解消する手法。|

---

[↑ 目次に戻る](#-目次)

---
