---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第45回：ネットワークや依存リソースの変更に引きずられる連鎖的再生成'
description: 'ネットワーク等の依存リソースがForceNew属性の変更によって削除、再作成される際、参照構造を通じて接続先のコンテナ群にまで変更が波及する構造を整理する。単一リソースの変更が意図しない範囲まで連鎖する現象を実機で確認する。'
pubDate: 2026-09-16
category: 'infra'
tags: ['Ansible', 'Terraform', 'lifecycle', 'ForceNew', 'Docker Network']
seriesId: 'ansible-terraform-part5'
seriesNo: 45
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-46/'
relatedSeries: ''
---


<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第5部まとめブログ：Terraformライフサイクル破壊編で明らかになった「認識の不可視性」の構造** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [`docker_network`のForceNew属性](#2-docker_networkのforcenew属性)
3. [`networks_advanced`による参照構造](#3-networks_advancedによる参照構造)
4. [連鎖の伝播範囲](#4-連鎖の伝播範囲)
5. [実機再現：ネットワーク変更によるコンテナ群への波及](#5-実機再現ネットワーク変更によるコンテナ群への波及)
6. [まとめ](#6-まとめ)
7. [次回予告](#7-次回予告)
8. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#8-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

Terraformによるリソースの再生成が影響を及ぼす範囲は、変更対象として指定したリソース自身にとどまるとは限りません。

**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** では、`lifecycle`ブロックによる強制再生成によって、変更対象そのものであるコンテナが再生成され、Ansibleが投じた設定が消失することを確認しました。**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** では、この再生成が、静的な設定だけでなく稼働後に生成され続ける動的なデータも同様に消し去ることを実機で確認しました。いずれの回においても、再生成が発生するのは、変更対象として指定したリソースそのものでした。

第45回となる今回は、この前提が崩れるケースを扱います。意図して変更したのはネットワークだけのはずが、それに接続しているコンテナ群まで巻き込まれて再生成されてしまう現象です。直接触っていないリソースが、なぜ再生成の対象になるのかを整理します。

この回で扱う問いは、「ネットワークの再生成が、なぜ接続先のコンテナにまで影響するのか」です。

次のセクションでは、この問いの出発点となる、ネットワーク側の属性がどのような挙動を持つかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. `docker_network`のForceNew属性

依存元となるネットワーク側の挙動を整理するセクションです。

Dockerのネットワーク設定（ドライバ・IPAM設定等）は、Docker Engine自体が既存ネットワークの直接変更に対応していません。そのため、この種の属性を変更した場合、Terraform上ではネットワークリソース自体が削除、再作成される計画になります。実機で確認します。

### ■ 検証内容：`docker_network`のIPAM設定変更

検証環境の`docker_network.lab_net`に、明示的なサブネット指定（`ipam_config`ブロック）を追加します。

* **ファイル名：`main.tf`（既存の`docker_network.lab_net`リソース）**

【変更前】

```hcl
resource "docker_network" "lab_net" {
  name = "ansible-lab-net"
}
```

【変更後】

```hcl
resource "docker_network" "lab_net" {
  name = "ansible-lab-net"

  ipam_config {
    subnet = "172.20.0.0/24"
  }
}
```

target-node1〜3が実際に払い出されている内部IPアドレス帯と同じサブネットを、Docker任せの自動割当から明示指定に切り替えます。

この状態で`terraform plan`を実行します。

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

  # docker_network.lab_net must be replaced
-/+ resource "docker_network" "lab_net" {
      - attachable   = false -> null
      ~ driver       = "bridge" -> (known after apply)
      ~ id           = "261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354" -> (known after apply)
      - ingress      = false -> null
      ~ internal     = false -> (known after apply)
      - ipam_options = {} -> null
      - ipv6         = false -> null
        name         = "ansible-lab-net"
      ~ options      = {} -> (known after apply)
      ~ scope        = "local" -> (known after apply)
        # (1 unchanged attribute hidden)

      - ipam_config { # forces replacement
          - aux_address = {} -> null
          - gateway     = "172.20.0.1" -> null
          - subnet      = "172.20.0.0/24" -> null
            # (1 unchanged attribute hidden)
        }
      + ipam_config { # forces replacement
          + subnet   = "172.20.0.0/24"
            # (2 unchanged attributes hidden)
        }
    }

Plan: 1 to add, 0 to change, 1 to destroy.

（途中省略：Note行）
```

### ■ 結果

`docker_network.lab_net`自体が`-/+ destroy and then create replacement`として計画され、`Plan: 1 to add, 0 to change, 1 to destroy`という結果になりました。この時点では、target-node1〜3を含む他のリソースには一切変更が計画されていません。

Dockerのネットワーク設定の多くの属性は、既存ネットワークへの直接更新にDocker Engineが対応していないため、Terraform上ではForceNew（削除、再作成）として扱われることが確認できました。ネットワーク自体が再生成されれば、新しい`id`が発行されます。

次のセクションでは、この新しく発行される`id`を、コンテナ側がどのように参照しているかという構造を整理します。

---

[↑ 目次に戻る](#-目次)

---


## 3. `networks_advanced`による参照構造

再生成が伝播する仕組みを整理するセクションです。

`docker_container`が`networks_advanced`ブロックでネットワークを参照する際、参照先には`name`または`id`のいずれかを指定できます。この参照方法の違いが、セクション2で確認したネットワークの再生成が、コンテナ側に伝播するかどうかを左右します。

### ■ 検証環境の構成

検証環境では、ノードごとの接続先ネットワークが`locals`ブロックで以下のように定義されています。

```hcl
locals {
  target_nodes = {
    "target-node1" = 2231
    "target-node2" = 2222
    "target-node3" = 2223
  }
  target_node_networks = {
    # "target-node1" = [docker_network.lab_net.id, docker_network.app_net.name]
    "target-node1" = [docker_network.lab_net.id]
    "target-node2" = [docker_network.lab_net.id]
    "target-node3" = [docker_network.lab_net.id]
  }
}
```

`target_node_networks`は、各ノード名をキーとして、接続先ネットワークのリストを値に持つマップです。target-node1〜3いずれも、リストの中身は`docker_network.lab_net.id`一つのみです。

この`target_node_networks`を、`docker_container.targets`側が以下のように参照しています。

```hcl
resource "docker_container" "targets" {
  for_each = local.target_nodes
  name     = each.key
  image    = module.image_ansible_target.image_id
  dynamic "networks_advanced" {
    for_each = local.target_node_networks[each.key]
    content {
      name = networks_advanced.value
    }
  }
  ports {
    internal = 22
    external = each.value
  }
  upload {
    file    = "/home/ansible/.ssh/authorized_keys"
    content = "${file("${path.module}/id_ed25519.pub")}\n${tls_private_key.generated.public_key_openssh}"
  }
  upload {
    file    = "/etc/init_marker"
    content = "init_version=v1\n"
  }
  lifecycle {
    replace_triggered_by = [tls_private_key.generated]
    ignore_changes = [network_mode]
  }
}
```

`dynamic "networks_advanced"`ブロックは`local.target_node_networks[each.key]`をループしており、その中の`networks_advanced.value`が、実際には`local.target_node_networks`のリストの要素、つまり`docker_network.lab_net.id`そのものです。`content`ブロック内の`name = networks_advanced.value`という記述により、`networks_advanced`の`name`引数（ネットワークの名前またはIDを受け付ける引数）に、`docker_network.lab_net`の`id`が渡される構造になっています。

### ■ `id`参照によって生じる依存関係

`docker_network.lab_net`が再生成されると、Docker Engine上で新しいネットワークが作成し直されるため、新しい`id`が発行されます。`docker_container.targets`側の`networks_advanced`ブロックは、この`id`を参照しているため、参照先の値そのものが変化したとTerraformに認識されます。

セクション2の検証時に取得した`terraform plan`結果には、`docker_network.lab_net`の再生成に続けて、`docker_container.targets["target-node1"]`に以下の変更が計画されていました。

```plaintext
  # docker_container.targets["target-node1"] must be replaced
-/+ resource "docker_container" "targets" {
      + bridge                                      = (known after apply)
      ~ command                                     = [
          - "/usr/sbin/sshd",
          - "-D",
        ] -> (known after apply)
      + container_logs                              = (known after apply)
      - cpu_shares                                  = 0 -> null
      - dns                                         = [] -> null
      - dns_opts                                    = [] -> null
      - dns_search                                  = [] -> null
      ~ entrypoint                                  = [] -> (known after apply)
      ~ env                                         = [] -> (known after apply)
      + exit_code                                   = (known after apply)
      - group_add                                   = [] -> null
      ~ hostname                                    = "3d2eae6f0af6" -> (known after apply)
      ~ id                                          = "3d2eae6f0af6af7c7fcf61df9d5417d60fc665884673c6ac3e5dbf472a0dcfd6" -> (known after apply)
      ~ init                                        = false -> (known after apply)
      ~ ipc_mode                                    = "private" -> (known after apply)
      ~ log_driver                                  = "json-file" -> (known after apply)
      - log_opts                                    = {} -> null
      - max_retry_count                             = 0 -> null
      - memory                                      = 0 -> null
      - memory_swap                                 = 0 -> null
        name                                        = "target-node1"
      ~ network_data                                = [
          - {
              - gateway                   = "172.20.0.1"
              - global_ipv6_prefix_length = 0
              - ip_address                = "172.20.0.4"
              - ip_prefix_length          = 24
              - mac_address               = "8e:69:ce:e7:c7:02"
              - network_name              = "ansible-lab-net"
                # (2 unchanged attributes hidden)
            },
        ] -> (known after apply)
      - network_mode                                = "bridge" -> null
      - privileged                                  = false -> null
      - publish_all_ports                           = false -> null
      ~ runtime                                     = "runc" -> (known after apply)
      ~ security_opts                               = [] -> (known after apply)
      ~ shm_size                                    = 64 -> (known after apply)
      + stop_signal                                 = (known after apply)
      ~ stop_timeout                                = 0 -> (known after apply)
      - storage_opts                                = {} -> null
      - sysctls                                     = {} -> null
      - tmpfs                                       = {} -> null
        # (20 unchanged attributes hidden)

      ~ healthcheck (known after apply)

      ~ labels (known after apply)

      - networks_advanced { # forces replacement
          - aliases      = [] -> null
          - name         = "ansible-lab-net" -> null
            # (2 unchanged attributes hidden)
        }
      + networks_advanced { # forces replacement
          + aliases      = []
          + name         = (known after apply)
            # (2 unchanged attributes hidden)
        }

        # (3 unchanged blocks hidden)
    }
```

`networks_advanced`ブロックに`# forces replacement`という注記が付き、`docker_container.targets["target-node1"]`自体が`must be replaced`となっています。参照先である`docker_network.lab_net`の`id`が変わることで、参照元であるコンテナ側の設定も変化したとみなされ、コンテナ自体の再生成が引き起こされる構造です。target-node2、target-node3についても同様の差分が計画されています。

### ■ `name`参照であった場合との対比

なお、この参照が`id`ではなく`name`であった場合は、状況が異なります。`docker_network`の`name`属性は、ネットワークが再生成されても値自体は変わりません。そのため、`networks_advanced`ブロックが`name`を参照している構成では、ネットワークが再生成されても参照元の実質的な値に変化が生じず、コンテナ側への伝播は起きません。

```

【id参照の場合】
docker_network.lab_net の再生成
　↓
id が変化する（新しい値が発行される）
　↓
networks_advanced が参照する値が変化したとみなされる
　↓
docker_container.targets も再生成される

【name参照の場合】
docker_network.lab_net の再生成
　↓
name は変化しない（`ansible-lab-net` のまま）
　↓
networks_advanced が参照する値に変化がない
　↓
docker_container.targets への伝播は発生しない

```

`id`のように、リソースが再生成されるたびに値が変わる属性を他のリソースが参照する構成は、Docker固有のものではなく、Terraformの依存関係解決における一般的な性質です。参照先の再生成によって参照元にも変更が波及する構造は、Dockerのネットワークとコンテナに限らず、他のプロバイダーでも同様に起こり得ます。

次のセクションでは、この伝播が単一のコンテナにとどまらず、複数のコンテナへどのように広がるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 4. 連鎖の伝播範囲

被害範囲が単一リソースにとどまらないことを整理するセクションです。

セクション3では、target-node1について`docker_network.lab_net`の再生成が`docker_container.targets["target-node1"]`の再生成に波及する構造を確認しました。同一の`terraform plan`結果には、target-node2、target-node3についても同様の差分が含まれています。

**▼ `terraform plan`結果（target-node2、target-node3部分）**

```plaintext
  # docker_container.targets["target-node2"] must be replaced
-/+ resource "docker_container" "targets" {
      + bridge                                      = (known after apply)
      ~ command                                     = [
          - "/usr/sbin/sshd",
          - "-D",
        ] -> (known after apply)
      + container_logs                              = (known after apply)
      - cpu_shares                                  = 0 -> null
      - dns                                         = [] -> null
      - dns_opts                                    = [] -> null
      - dns_search                                  = [] -> null
      ~ entrypoint                                  = [] -> (known after apply)
      ~ env                                         = [] -> (known after apply)
      + exit_code                                   = (known after apply)
      - group_add                                   = [] -> null
      ~ hostname                                    = "459b96c88750" -> (known after apply)
      ~ id                                          = "459b96c887507d8807f5c724ff5ee08e0cc522084f809c854c50099349f22b11" -> (known after apply)
      ~ init                                        = false -> (known after apply)
      ~ ipc_mode                                    = "private" -> (known after apply)
      ~ log_driver                                  = "json-file" -> (known after apply)
      - log_opts                                    = {} -> null
      - max_retry_count                             = 0 -> null
      - memory                                      = 0 -> null
      - memory_swap                                 = 0 -> null
        name                                        = "target-node2"
      ~ network_data                                = [
          - {
              - gateway                   = "172.20.0.1"
              - global_ipv6_prefix_length = 0
              - ip_address                = "172.20.0.3"
              - ip_prefix_length          = 24
              - mac_address               = "26:32:94:19:db:83"
              - network_name              = "ansible-lab-net"
                # (2 unchanged attributes hidden)
            },
        ] -> (known after apply)
      - network_mode                                = "bridge" -> null
      - privileged                                  = false -> null
      - publish_all_ports                           = false -> null
      ~ runtime                                     = "runc" -> (known after apply)
      ~ security_opts                               = [] -> (known after apply)
      ~ shm_size                                    = 64 -> (known after apply)
      + stop_signal                                 = (known after apply)
      ~ stop_timeout                                = 0 -> (known after apply)
      - storage_opts                                = {} -> null
      - sysctls                                     = {} -> null
      - tmpfs                                       = {} -> null
        # (20 unchanged attributes hidden)

      ~ healthcheck (known after apply)

      ~ labels (known after apply)

      - networks_advanced { # forces replacement
          - aliases      = [] -> null
          - name         = "ansible-lab-net" -> null
            # (2 unchanged attributes hidden)
        }
      + networks_advanced { # forces replacement
          + aliases      = []
          + name         = (known after apply)
            # (2 unchanged attributes hidden)
        }

        # (3 unchanged blocks hidden)
    }

  # docker_container.targets["target-node3"] must be replaced
-/+ resource "docker_container" "targets" {
      + bridge                                      = (known after apply)
      ~ command                                     = [
          - "/usr/sbin/sshd",
          - "-D",
        ] -> (known after apply)
      + container_logs                              = (known after apply)
      - cpu_shares                                  = 0 -> null
      - dns                                         = [] -> null
      - dns_opts                                    = [] -> null
      - dns_search                                  = [] -> null
      ~ entrypoint                                  = [] -> (known after apply)
      ~ env                                         = [] -> (known after apply)
      + exit_code                                   = (known after apply)
      - group_add                                   = [] -> null
      ~ hostname                                    = "40d075660c8e" -> (known after apply)
      ~ id                                          = "40d075660c8e1a2c6608e2105a1cb7ff5ec2923fa7268de933d86672cb1a378a" -> (known after apply)
      ~ init                                        = false -> (known after apply)
      ~ ipc_mode                                    = "private" -> (known after apply)
      ~ log_driver                                  = "json-file" -> (known after apply)
      - log_opts                                    = {} -> null
      - max_retry_count                             = 0 -> null
      - memory                                      = 0 -> null
      - memory_swap                                 = 0 -> null
        name                                        = "target-node3"
      ~ network_data                                = [
          - {
              - gateway                   = "172.20.0.1"
              - global_ipv6_prefix_length = 0
              - ip_address                = "172.20.0.2"
              - ip_prefix_length          = 24
              - mac_address               = "86:e3:cd:11:23:4f"
              - network_name              = "ansible-lab-net"
                # (2 unchanged attributes hidden)
            },
        ] -> (known after apply)
      - network_mode                                = "bridge" -> null
      - privileged                                  = false -> null
      - publish_all_ports                           = false -> null
      ~ runtime                                     = "runc" -> (known after apply)
      ~ security_opts                               = [] -> (known after apply)
      ~ shm_size                                    = 64 -> (known after apply)
      + stop_signal                                 = (known after apply)
      ~ stop_timeout                                = 0 -> (known after apply)
      - storage_opts                                = {} -> null
      - sysctls                                     = {} -> null
      - tmpfs                                       = {} -> null
        # (20 unchanged attributes hidden)

      ~ healthcheck (known after apply)

      ~ labels (known after apply)

      - networks_advanced { # forces replacement
          - aliases      = [] -> null
          - name         = "ansible-lab-net" -> null
            # (2 unchanged attributes hidden)
        }
      + networks_advanced { # forces replacement
          + aliases      = []
          + name         = (known after apply)
            # (2 unchanged attributes hidden)
        }

        # (3 unchanged blocks hidden)
    }
```

target-node1と同様、target-node2、target-node3いずれも`networks_advanced`ブロックに`# forces replacement`が付き、`must be replaced`となっています。単一の`docker_network.lab_net`に3台のコンテナが接続している構成では、ネットワーク1つの再生成が3台すべてに同時に波及することが確認できました。

### ■ さらに先へ波及する変更

この`terraform plan`結果には、コンテナ以外の変更も含まれていました。`local_file.ansible_inventory`と`local_file.group_vars_target_nodes`です。

**▼ `terraform plan`結果（`local_file`部分）**

```plaintext
  # local_file.ansible_inventory must be replaced
-/+ resource "local_file" "ansible_inventory" {
      ~ content              = <<-EOT
            [target_nodes]
            target-node1 ansible_host=172.20.0.4 ansible_user=ansible
            target-node2 ansible_host=172.20.0.3 ansible_user=ansible
            target-node3 ansible_host=172.20.0.2 ansible_user=ansible
        EOT -> (known after apply) # forces replacement
      ~ content_base64sha256 = "m2Gvh+ST2vT7FTjT+DWJhBa3gm87ChOQR03ECGT4IEQ=" -> (known after apply)
      ~ content_base64sha512 = "q0t4StuW5GWgueGW2zSmRBeQsxbo08KwZNaJ4KqrsJAQOpMxxABmgXBJfM/KyNehOqD6rREkfe/FIWsUYVoI1A==" -> (known after apply)
      ~ content_md5          = "116a43ce58b5e0635d3d1765e0ce7f12" -> (known after apply)
      ~ content_sha1         = "733afaba17b50383acf6b02a681a2bf4379feed0" -> (known after apply)
      ~ content_sha256       = "9b61af87e493daf4fb1538d3f835898416b7826f3b0a1390474dc40864f82044" -> (known after apply)
      ~ content_sha512       = "ab4b784adb96e465a0b9e196db34a6441790b316e8d3c2b064d689e0aaabb090103a9331c400668170497ccfcac8d7a13aa0faad11247defc5216b14615a08d4" -> (known after apply)
      ~ id                   = "733afaba17b50383acf6b02a681a2bf4379feed0" -> (known after apply)
        # (3 unchanged attributes hidden)
    }

  # local_file.group_vars_target_nodes must be replaced
-/+ resource "local_file" "group_vars_target_nodes" {
      ~ content              = <<-EOT
            nginx_settings:
              worker_connections: 768
              targets:
              - name: target-node1
                ip: 172.20.0.4
              - name: target-node2
                ip: 172.20.0.3
              - name: target-node3
                ip: 172.20.0.2
        EOT -> (known after apply) # forces replacement
      ~ content_base64sha256 = "eAN5el4BZbyFb5rnzRQCyAPITXDJagKCAKP2IrwZHxg=" -> (known after apply)
      ~ content_base64sha512 = "fdW5mw2EGzvjehr0paz9NU9ftLW+lKVqboB8aOQnscx2uRjAk7/gZpbwgXeLJzKb6Sy2wBBdxoTfBa5LiVeT+w==" -> (known after apply)
      ~ content_md5          = "046daae45c45c3f468cbcbfea3162a3a" -> (known after apply)
      ~ content_sha1         = "c0fbb73f582c7117ef952466f59125185ed5d43e" -> (known after apply)
      ~ content_sha256       = "7803797a5e0165bc856f9ae7cd1402c803c84d70c96a028200a3f622bc191f18" -> (known after apply)
      ~ content_sha512       = "7dd5b99b0d841b3be37a1af4a5acfd354f5fb4b5be94a56a6e807c68e427b1cc76b918c093bfe06696f081778b27329be92cb6c0105dc684df05ae4b895793fb" -> (known after apply)
      ~ id                   = "c0fbb73f582c7117ef952466f59125185ed5d43e" -> (known after apply)
        # (3 unchanged attributes hidden)
    }
```

セクション5でも整理する通り、この2つの`local_file`リソースは、`docker_container.targets`が持つ`network_data[0].ip_address`（コンテナの内部IPアドレス）を参照して内容を生成しています。コンテナが再生成されると、内部IPアドレスが変動する可能性があるため、コンテナ側の変更が、さらにこの2つの`local_file`にまで連鎖しています。

`terraform plan`全体の集計は以下の通りでした。

```plaintext
Plan: 6 to add, 0 to change, 6 to destroy.
```

`docker_network.lab_net`（1）、`docker_container.targets`3台（3）、`local_file`2つ（2）の合計6リソースです。ネットワーク1つに対する属性変更が、直接の参照元であるコンテナ3台、さらにそのコンテナに依存する設定ファイル群にまで、段階的に波及する構造が確認できました。

### ■ 「再接続」と「破棄・再作成」の違い

なお、ネットワーク再作成によってコンテナ側に生じる変更が、コンテナの「再接続（更新）」で済むのか、コンテナ自体の「破棄・再作成」まで至るのかは、コンテナ側の該当属性の性質に依存します。今回の`terraform plan`結果では、`networks_advanced`ブロックの変更に`# forces replacement`という注記が付いており、target-node1〜3いずれも`must be replaced`、つまり再接続ではなく破棄・再作成として計画されています。この点については、次のセクションの実機検証で、`terraform apply`を実行した際に実際どちらの挙動になるかを確認します。

次のセクションでは、ここまでの`terraform plan`の結果を踏まえ、`terraform apply`を実行し、実際にコンテナが再作成されること、そして **[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** 同様、投入済みのデータが消失することを実機で確認します。

---

[↑ 目次に戻る](#-目次)

---

## 5. 実機再現：ネットワーク変更によるコンテナ群への波及

この回の総仕上げとなる検証セクションです。3台のtarget-nodeが接続している共通ネットワークの属性を変更し、`terraform plan`でtarget-node1〜3全てに変更が波及することを確認したうえで、`terraform apply`を実行し、投入していたデータが消失することを確認します。

### ■ 検証内容：Ansibleによるデータ投入

target-node1〜3それぞれに、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** と同様の簡易データストアを構築します。

* **ファイル名：`playbooks/data_loss_marker_part5_45.yml`（新規作成）**

```yaml
---
- name: 第45回検証用データストア投入Playbook
  hosts: target_nodes
  gather_facts: false
  become: true

  tasks:
    - name: sqlite3パッケージをインストール
      ansible.builtin.apt:
        name: sqlite3
        state: present
        update_cache: true

    - name: データ格納用ディレクトリを作成
      ansible.builtin.file:
        path: /var/lib/app_data
        state: directory
        mode: '0755'

    - name: テーブルを作成しレコードを投入
      ansible.builtin.command:
        cmd: >
          sqlite3 /var/lib/app_data/records.db
          "CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, note TEXT);
           INSERT INTO records (note) VALUES ('record-1'), ('record-2'), ('record-3');"
```

**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** はtarget-node1のみを対象としていましたが、今回は`hosts`を`target_nodes`（インベントリの全ノードグループ）とし、3台すべてに同一のデータを投入します。

**実行コマンド**

```plaintext
ansible-playbook -i ../../docker-lab/inventory.ini data_loss_marker_part5_45.yml
```

**▼ 実行結果**

```plaintext
PLAY [第45回検証用データストア投入Playbook] *************************************************************************************************************************************************

TASK [sqlite3パッケージをインストール] ******************************************************************************************************************************************************
[WARNING]: Platform linux on host target-node2 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
changed: [target-node2]
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
changed: [target-node1]
[WARNING]: Platform linux on host target-node3 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
changed: [target-node3]

TASK [データ格納用ディレクトリを作成] *******************************************************************************************************************************************************
changed: [target-node3]
changed: [target-node1]
changed: [target-node2]

TASK [テーブルを作成しレコードを投入] *******************************************************************************************************************************************************
changed: [target-node2]
changed: [target-node1]
changed: [target-node3]

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=3    changed=3    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=3    changed=3    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=3    changed=3    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

投入内容を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "sqlite3 /var/lib/app_data/records.db 'SELECT * FROM records;'"
docker exec -it target-node2 bash -c "sqlite3 /var/lib/app_data/records.db 'SELECT * FROM records;'"
docker exec -it target-node3 bash -c "sqlite3 /var/lib/app_data/records.db 'SELECT * FROM records;'"
```

**▼ 実行結果**

```plaintext
1|record-1
2|record-2
3|record-3
1|record-1
2|record-2
3|record-3
1|record-1
2|record-2
3|record-3
```

target-node1〜3すべてに、3件のレコードが存在する状態になりました。

### ■ 検証内容：`docker_network`のIPAM設定変更と`terraform plan`

セクション2で適用済みの`docker_network.lab_net`への`ipam_config`追加、およびセクション3で適用済みの`networks_advanced`の`id`参照化がそのまま反映された状態で、`terraform plan`を実行します。

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
docker_network.app_net: Refreshing state... [id=54f7b73fd1625642a3ef6ed67fbde6f93062353422a9afeced223cd940c4c5ca]
tls_private_key.generated: Refreshing state... [id=5e8bb2b04307c5dcb8c11a464519006f7f02cee3]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
module.image_deploy_passwd.docker_image.this: Refreshing state... [id=sha256:82e7f3fe0d4812ff81d66c343eb1c9256083f74beaa95a6ea0cbbd4cf248649dansible-target:deploy-passwd]
module.image_deploy_nopasswd.docker_image.this: Refreshing state... [id=sha256:82e7f3fe0d4812ff81d66c343eb1c9256083f74beaa95a6ea0cbbd4cf248649dansible-target:deploy-nopasswd]
module.image_ansible_target.docker_image.this: Refreshing state... [id=sha256:32ab5c4e8d486ce8c1c2437c66cd22ad3d90048329efe06897302d2ac49c6456ansible-target:ubuntu22.04]
module.image_legacy.docker_image.this: Refreshing state... [id=sha256:a16c62a2699b6a0020002e924eff95e64e701b5f89b92247875e66365ced49b0ansible-target:ubuntu18.04]
local_file.private_key: Refreshing state... [id=fb02f9a5cc39ef2541906fa5905ca99b8e1cdca4]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node3"]: Refreshing state... [id=40d075660c8e1a2c6608e2105a1cb7ff5ec2923fa7268de933d86672cb1a378a]
docker_container.targets["target-node1"]: Refreshing state... [id=3d2eae6f0af6af7c7fcf61df9d5417d60fc665884673c6ac3e5dbf472a0dcfd6]
docker_container.targets["target-node2"]: Refreshing state... [id=459b96c887507d8807f5c724ff5ee08e0cc522084f809c854c50099349f22b11]
local_file.group_vars_target_nodes: Refreshing state... [id=c0fbb73f582c7117ef952466f59125185ed5d43e]
local_file.ansible_inventory: Refreshing state... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
null_resource.provision: Refreshing state... [id=9097844746803381095]

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] must be replaced
-/+ resource "docker_container" "targets" {
      + bridge                                      = (known after apply)
      ~ command                                     = [
          - "/usr/sbin/sshd",
          - "-D",
        ] -> (known after apply)
      + container_logs                              = (known after apply)
      - cpu_shares                                  = 0 -> null
      - dns                                         = [] -> null
      - dns_opts                                    = [] -> null
      - dns_search                                  = [] -> null
      ~ entrypoint                                  = [] -> (known after apply)
      ~ env                                         = [] -> (known after apply)
      + exit_code                                   = (known after apply)
      - group_add                                   = [] -> null
      ~ hostname                                    = "3d2eae6f0af6" -> (known after apply)
      ~ id                                          = "3d2eae6f0af6af7c7fcf61df9d5417d60fc665884673c6ac3e5dbf472a0dcfd6" -> (known after apply)
      ~ init                                        = false -> (known after apply)
      ~ ipc_mode                                    = "private" -> (known after apply)
      ~ log_driver                                  = "json-file" -> (known after apply)
      - log_opts                                    = {} -> null
      - max_retry_count                             = 0 -> null
      - memory                                      = 0 -> null
      - memory_swap                                 = 0 -> null
        name                                        = "target-node1"
      ~ network_data                                = [
          - {
              - gateway                   = "172.20.0.1"
              - global_ipv6_prefix_length = 0
              - ip_address                = "172.20.0.4"
              - ip_prefix_length          = 24
              - mac_address               = "8e:69:ce:e7:c7:02"
              - network_name              = "ansible-lab-net"
                # (2 unchanged attributes hidden)
            },
        ] -> (known after apply)
      - network_mode                                = "bridge" -> null
      - privileged                                  = false -> null
      - publish_all_ports                           = false -> null
      ~ runtime                                     = "runc" -> (known after apply)
      ~ security_opts                               = [] -> (known after apply)
      ~ shm_size                                    = 64 -> (known after apply)
      + stop_signal                                 = (known after apply)
      ~ stop_timeout                                = 0 -> (known after apply)
      - storage_opts                                = {} -> null
      - sysctls                                     = {} -> null
      - tmpfs                                       = {} -> null
        # (20 unchanged attributes hidden)

      ~ healthcheck (known after apply)

      ~ labels (known after apply)

      - networks_advanced { # forces replacement
          - aliases      = [] -> null
          - name         = "ansible-lab-net" -> null
            # (2 unchanged attributes hidden)
        }
      + networks_advanced { # forces replacement
          + aliases      = []
          + name         = (known after apply)
            # (2 unchanged attributes hidden)
        }

        # (3 unchanged blocks hidden)
    }

  # docker_container.targets["target-node2"] must be replaced
-/+ resource "docker_container" "targets" {
      + bridge                                      = (known after apply)
      ~ command                                     = [
          - "/usr/sbin/sshd",
          - "-D",
        ] -> (known after apply)
      + container_logs                              = (known after apply)
      - cpu_shares                                  = 0 -> null
      - dns                                         = [] -> null
      - dns_opts                                    = [] -> null
      - dns_search                                  = [] -> null
      ~ entrypoint                                  = [] -> (known after apply)
      ~ env                                         = [] -> (known after apply)
      + exit_code                                   = (known after apply)
      - group_add                                   = [] -> null
      ~ hostname                                    = "459b96c88750" -> (known after apply)
      ~ id                                          = "459b96c887507d8807f5c724ff5ee08e0cc522084f809c854c50099349f22b11" -> (known after apply)
      ~ init                                        = false -> (known after apply)
      ~ ipc_mode                                    = "private" -> (known after apply)
      ~ log_driver                                  = "json-file" -> (known after apply)
      - log_opts                                    = {} -> null
      - max_retry_count                             = 0 -> null
      - memory                                      = 0 -> null
      - memory_swap                                 = 0 -> null
        name                                        = "target-node2"
      ~ network_data                                = [
          - {
              - gateway                   = "172.20.0.1"
              - global_ipv6_prefix_length = 0
              - ip_address                = "172.20.0.3"
              - ip_prefix_length          = 24
              - mac_address               = "26:32:94:19:db:83"
              - network_name              = "ansible-lab-net"
                # (2 unchanged attributes hidden)
            },
        ] -> (known after apply)
      - network_mode                                = "bridge" -> null
      - privileged                                  = false -> null
      - publish_all_ports                           = false -> null
      ~ runtime                                     = "runc" -> (known after apply)
      ~ security_opts                               = [] -> (known after apply)
      ~ shm_size                                    = 64 -> (known after apply)
      + stop_signal                                 = (known after apply)
      ~ stop_timeout                                = 0 -> (known after apply)
      - storage_opts                                = {} -> null
      - sysctls                                     = {} -> null
      - tmpfs                                       = {} -> null
        # (20 unchanged attributes hidden)

      ~ healthcheck (known after apply)

      ~ labels (known after apply)

      - networks_advanced { # forces replacement
          - aliases      = [] -> null
          - name         = "ansible-lab-net" -> null
            # (2 unchanged attributes hidden)
        }
      + networks_advanced { # forces replacement
          + aliases      = []
          + name         = (known after apply)
            # (2 unchanged attributes hidden)
        }

        # (3 unchanged blocks hidden)
    }

  # docker_container.targets["target-node3"] must be replaced
-/+ resource "docker_container" "targets" {
      + bridge                                      = (known after apply)
      ~ command                                     = [
          - "/usr/sbin/sshd",
          - "-D",
        ] -> (known after apply)
      + container_logs                              = (known after apply)
      - cpu_shares                                  = 0 -> null
      - dns                                         = [] -> null
      - dns_opts                                    = [] -> null
      - dns_search                                  = [] -> null
      ~ entrypoint                                  = [] -> (known after apply)
      ~ env                                         = [] -> (known after apply)
      + exit_code                                   = (known after apply)
      - group_add                                   = [] -> null
      ~ hostname                                    = "40d075660c8e" -> (known after apply)
      ~ id                                          = "40d075660c8e1a2c6608e2105a1cb7ff5ec2923fa7268de933d86672cb1a378a" -> (known after apply)
      ~ init                                        = false -> (known after apply)
      ~ ipc_mode                                    = "private" -> (known after apply)
      ~ log_driver                                  = "json-file" -> (known after apply)
      - log_opts                                    = {} -> null
      - max_retry_count                             = 0 -> null
      - memory                                      = 0 -> null
      - memory_swap                                 = 0 -> null
        name                                        = "target-node3"
      ~ network_data                                = [
          - {
              - gateway                   = "172.20.0.1"
              - global_ipv6_prefix_length = 0
              - ip_address                = "172.20.0.2"
              - ip_prefix_length          = 24
              - mac_address               = "86:e3:cd:11:23:4f"
              - network_name              = "ansible-lab-net"
                # (2 unchanged attributes hidden)
            },
        ] -> (known after apply)
      - network_mode                                = "bridge" -> null
      - privileged                                  = false -> null
      - publish_all_ports                           = false -> null
      ~ runtime                                     = "runc" -> (known after apply)
      ~ security_opts                               = [] -> (known after apply)
      ~ shm_size                                    = 64 -> (known after apply)
      + stop_signal                                 = (known after apply)
      ~ stop_timeout                                = 0 -> (known after apply)
      - storage_opts                                = {} -> null
      - sysctls                                     = {} -> null
      - tmpfs                                       = {} -> null
        # (20 unchanged attributes hidden)

      ~ healthcheck (known after apply)

      ~ labels (known after apply)

      - networks_advanced { # forces replacement
          - aliases      = [] -> null
          - name         = "ansible-lab-net" -> null
            # (2 unchanged attributes hidden)
        }
      + networks_advanced { # forces replacement
          + aliases      = []
          + name         = (known after apply)
            # (2 unchanged attributes hidden)
        }

        # (3 unchanged blocks hidden)
    }

  # docker_network.lab_net must be replaced
-/+ resource "docker_network" "lab_net" {
      - attachable   = false -> null
      ~ driver       = "bridge" -> (known after apply)
      ~ id           = "261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354" -> (known after apply)
      - ingress      = false -> null
      ~ internal     = false -> (known after apply)
      - ipam_options = {} -> null
      - ipv6         = false -> null
        name         = "ansible-lab-net"
      ~ options      = {} -> (known after apply)
      ~ scope        = "local" -> (known after apply)
        # (1 unchanged attribute hidden)

      - ipam_config { # forces replacement
          - aux_address = {} -> null
          - gateway     = "172.20.0.1" -> null
          - subnet      = "172.20.0.0/24" -> null
            # (1 unchanged attribute hidden)
        }
      + ipam_config { # forces replacement
          + subnet   = "172.20.0.0/24"
            # (2 unchanged attributes hidden)
        }
    }

  # local_file.ansible_inventory must be replaced
-/+ resource "local_file" "ansible_inventory" {
      ~ content              = <<-EOT
            [target_nodes]
            target-node1 ansible_host=172.20.0.4 ansible_user=ansible
            target-node2 ansible_host=172.20.0.3 ansible_user=ansible
            target-node3 ansible_host=172.20.0.2 ansible_user=ansible
        EOT -> (known after apply) # forces replacement
      ~ content_base64sha256 = "m2Gvh+ST2vT7FTjT+DWJhBa3gm87ChOQR03ECGT4IEQ=" -> (known after apply)
      ~ content_base64sha512 = "q0t4StuW5GWgueGW2zSmRBeQsxbo08KwZNaJ4KqrsJAQOpMxxABmgXBJfM/KyNehOqD6rREkfe/FIWsUYVoI1A==" -> (known after apply)
      ~ content_md5          = "116a43ce58b5e0635d3d1765e0ce7f12" -> (known after apply)
      ~ content_sha1         = "733afaba17b50383acf6b02a681a2bf4379feed0" -> (known after apply)
      ~ content_sha256       = "9b61af87e493daf4fb1538d3f835898416b7826f3b0a1390474dc40864f82044" -> (known after apply)
      ~ content_sha512       = "ab4b784adb96e465a0b9e196db34a6441790b316e8d3c2b064d689e0aaabb090103a9331c400668170497ccfcac8d7a13aa0faad11247defc5216b14615a08d4" -> (known after apply)
      ~ id                   = "733afaba17b50383acf6b02a681a2bf4379feed0" -> (known after apply)
        # (3 unchanged attributes hidden)
    }

  # local_file.group_vars_target_nodes must be replaced
-/+ resource "local_file" "group_vars_target_nodes" {
      ~ content              = <<-EOT
            nginx_settings:
              worker_connections: 768
              targets:
              - name: target-node1
                ip: 172.20.0.4
              - name: target-node2
                ip: 172.20.0.3
              - name: target-node3
                ip: 172.20.0.2
        EOT -> (known after apply) # forces replacement
      ~ content_base64sha256 = "eAN5el4BZbyFb5rnzRQCyAPITXDJagKCAKP2IrwZHxg=" -> (known after apply)
      ~ content_base64sha512 = "fdW5mw2EGzvjehr0paz9NU9ftLW+lKVqboB8aOQnscx2uRjAk7/gZpbwgXeLJzKb6Sy2wBBdxoTfBa5LiVeT+w==" -> (known after apply)
      ~ content_md5          = "046daae45c45c3f468cbcbfea3162a3a" -> (known after apply)
      ~ content_sha1         = "c0fbb73f582c7117ef952466f59125185ed5d43e" -> (known after apply)
      ~ content_sha256       = "7803797a5e0165bc856f9ae7cd1402c803c84d70c96a028200a3f622bc191f18" -> (known after apply)
      ~ content_sha512       = "7dd5b99b0d841b3be37a1af4a5acfd354f5fb4b5be94a56a6e807c68e427b1cc76b918c093bfe06696f081778b27329be92cb6c0105dc684df05ae4b895793fb" -> (known after apply)
      ~ id                   = "c0fbb73f582c7117ef952466f59125185ed5d43e" -> (known after apply)
        # (3 unchanged attributes hidden)
    }

Plan: 6 to add, 0 to change, 6 to destroy.

Changes to Outputs:
  ~ target_nodes     = {
      ~ target-node1 = {
          ~ host = "172.20.0.4" -> (known after apply)
            # (1 unchanged attribute hidden)
        }
      ~ target-node2 = {
          ~ host = "172.20.0.3" -> (known after apply)
            # (1 unchanged attribute hidden)
        }
      ~ target-node3 = {
          ~ host = "172.20.0.2" -> (known after apply)
            # (1 unchanged attribute hidden)
        }
    }
  ~ target_nodes_ips = {
      ~ target-node1 = "172.20.0.4" -> (known after apply)
      ~ target-node2 = "172.20.0.3" -> (known after apply)
      ~ target-node3 = "172.20.0.2" -> (known after apply)
    }

────────────────────────────────────────────────────────────────────────────────────────────── ──────────────────────────────────────────────────────────────────────────────────────────────

Note: You didn't use the -out option to save this plan, so Terraform can't guarantee to take exactly these actions if you run "terraform apply" now.
```

`docker_network.lab_net`本体、target-node1〜3、`local_file`2つの合計6リソースに再生成が計画されていることを、データ投入後の状態で改めて確認できました。

### ■ 検証内容：`terraform apply`の実行

この計画で`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Planの再掲）

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

local_file.ansible_inventory: Destroying... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
local_file.group_vars_target_nodes: Destroying... [id=c0fbb73f582c7117ef952466f59125185ed5d43e]
local_file.ansible_inventory: Destruction complete after 0s
local_file.group_vars_target_nodes: Destruction complete after 0s
docker_container.targets["target-node3"]: Destroying... [id=40d075660c8e1a2c6608e2105a1cb7ff5ec2923fa7268de933d86672cb1a378a]
docker_container.targets["target-node1"]: Destroying... [id=3d2eae6f0af6af7c7fcf61df9d5417d60fc665884673c6ac3e5dbf472a0dcfd6]
docker_container.targets["target-node2"]: Destroying... [id=459b96c887507d8807f5c724ff5ee08e0cc522084f809c854c50099349f22b11]
docker_container.targets["target-node3"]: Destruction complete after 2s
docker_container.targets["target-node1"]: Destruction complete after 2s
docker_container.targets["target-node2"]: Destruction complete after 2s
docker_network.lab_net: Destroying... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_network.lab_net: Destruction complete after 2s
docker_network.lab_net: Creating...
docker_network.lab_net: Creation complete after 3s [id=c9845cead8299bedfbe7a2e89c7387eab8b755d70a6b0f359de76c3e34ed9357]
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node2"]: Creating...
docker_container.targets["target-node3"]: Creating...
docker_container.targets["target-node3"]: Creation complete after 2s [id=e4bd329b00d7469a33f9343d340100c1495553a2dc4232ef4c5a0910e4525f9c]
docker_container.targets["target-node1"]: Creation complete after 2s [id=9783af80daab946f6e602d96bc8a0a9b650a51c5c82b63ead2ef3bfe0e2afd88]
docker_container.targets["target-node2"]: Creation complete after 2s [id=3e073905557972ae1dbc87110e51076468a33b2c1c2c82e15ef5d6b8e677e9c4]
local_file.group_vars_target_nodes: Creating...
local_file.group_vars_target_nodes: Creation complete after 0s [id=12377af3a22dd9a720e3b682fe97753d9b88a005]
local_file.ansible_inventory: Creating...
local_file.ansible_inventory: Creation complete after 1s [id=c645126c1aa8d63b8d60edb6a4679788d9a0bbe0]

Apply complete! Resources: 6 added, 0 changed, 6 destroyed.

Outputs:

target_nodes = {
  "target-node1" = {
    "host" = "172.20.0.3"
    "port" = 22
  }
  "target-node2" = {
    "host" = "172.20.0.4"
    "port" = 22
  }
  "target-node3" = {
    "host" = "172.20.0.2"
    "port" = 22
  }
}
target_nodes_ips = {
  "target-node1" = "172.20.0.3"
  "target-node2" = "172.20.0.4"
  "target-node3" = "172.20.0.2"
}
```

`Apply complete! Resources: 6 added, 0 changed, 6 destroyed`という、エラーのないログで完了しました。再作成後の内部IPアドレスは、再生成前（target-node1：172.20.0.4、target-node2：172.20.0.3、target-node3：172.20.0.2）から、target-node1が172.20.0.3、target-node2が172.20.0.4へと変動しており、target-node3のみ172.20.0.2のまま変わっていません。**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)**、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** で確認した「コンテナの内部IPアドレスは、再生成のたびに`local.target_nodes`のキー順と一致しない順序で割り当てられることがある」という環境の癖が、ここでも現れています。

### ■ 検証内容：データ消失の確認

再作成後のtarget-node1〜3で、投入していたデータストアの状態を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "sqlite3 /var/lib/app_data/records.db 'SELECT * FROM records;' 2>&1"
docker exec -it target-node2 bash -c "sqlite3 /var/lib/app_data/records.db 'SELECT * FROM records;' 2>&1"
docker exec -it target-node3 bash -c "sqlite3 /var/lib/app_data/records.db 'SELECT * FROM records;' 2>&1"
```

**▼ 実行結果**

```plaintext
bash: line 1: sqlite3: command not found
bash: line 1: sqlite3: command not found
bash: line 1: sqlite3: command not found
```

3台とも`sqlite3`コマンド自体が存在しないため、念のためディレクトリの存在も確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "ls -la /var/lib/app_data/ 2>&1"
docker exec -it target-node2 bash -c "ls -la /var/lib/app_data/ 2>&1"
docker exec -it target-node3 bash -c "ls -la /var/lib/app_data/ 2>&1"
```

**▼ 実行結果**

```plaintext
ls: cannot access '/var/lib/app_data/': No such file or directory
ls: cannot access '/var/lib/app_data/': No such file or directory
ls: cannot access '/var/lib/app_data/': No such file or directory
```

### ■ 結果

target-node1〜3すべてで、`sqlite3`コマンドが`command not found`、`/var/lib/app_data/`ディレクトリが`No such file or directory`という結果になりました。パッケージ、ディレクトリ、データベースファイル、レコードのすべてが、3台とも同様に失われています。

今回の一連の操作でユーザーが直接変更したのは`docker_network.lab_net`のみであり、target-node1〜3のいずれに対しても、直接的な変更操作は行っていません。それにもかかわらず、`networks_advanced`の`id`参照という構造を経由して、3台すべてが再生成の対象となり、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** で確認したデータ消失が、3台同時に発生しました。単一リソースへの変更が、意図しない範囲まで連鎖する構造が、実機で確認できました。

次のセクションでは、この回で整理した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 6. まとめ

この回で整理した内容を確認します。

* Dockerのネットワーク設定（ドライバ・IPAM設定等）の多くはDocker Engine自体が既存ネットワークへの直接更新に対応しておらず、Terraform上ではネットワークリソース自体がForceNew（削除、再作成）として扱われることを実機で確認した
* `docker_container`の`networks_advanced`ブロックがネットワークの`id`を参照している場合、参照先のネットワークが再生成されて`id`が変わると、参照元であるコンテナ側の設定も変化したとみなされ、コンテナ自体の再生成が引き起こされることを整理した。`name`のように再生成後も値が変わらない属性を参照している場合は、この伝播が起きない
* 単一の`docker_network.lab_net`にtarget-node1〜3が接続している構成では、ネットワーク1つの再生成が3台すべてに同時に波及することを実機で確認した。さらに、コンテナの内部IPアドレスを参照する`local_file.ansible_inventory`、`local_file.group_vars_target_nodes`にも二次的に波及し、`Plan: 6 to add, 0 to change, 6 to destroy`という結果になった
* target-node1〜3にAnsibleで投入した`sqlite3`パッケージ、データベースファイル、3件のレコードが、`docker_network.lab_net`の変更のみを起点とした連鎖的な再生成によって、3台すべてで失われることを実機で確認した
* `terraform apply`は`Apply complete! Resources: 6 added, 0 changed, 6 destroyed`というエラーのないログで完了しており、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** で扱った単一リソースの再生成に限らず、依存リソース経由の連鎖的な再生成でも同様にデータが消失することを確認した
* 参照先の再生成によって参照元にも変更が波及する構造は、Docker固有のものではなく、Terraformの依存関係解決における一般的な性質であり、他のプロバイダーでも同様に起こり得る

---

[↑ 目次に戻る](#-目次)

---

## 7. 次回予告

第45回となる今回は、変更対象として直接指定していないリソースまで再生成される、連鎖的な再生成の構造を扱いました。`docker_network`の多くの属性がForceNew相当であること、`networks_advanced`のようなリソース間参照によって変更が伝播すること、そしてその波及範囲が単一のコンテナにとどまらず、接続されている複数のコンテナ、さらにそのコンテナに依存する設定ファイルにまで及ぶことを、実機で確認しました。**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** で扱ったデータ消失が、このような依存リソース経由の連鎖によっても同様に発生することも確認しました。

次回は、再生成そのものではなく、Ansibleのプロビジョニング実行中に接続が切断、停止した場合に生じる、Terraformのstate上の不整合を扱います。

**[次回：第46回：プロビジョニング途中の接続切断とState不整合（ハーフデプロイ状態）](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-46/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)　｜　[次の記事：【Ansible×Terraform編】第46回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-46/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第5部まとめブログ：Terraformライフサイクル破壊編で明らかになった「認識の不可視性」の構造** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 8. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第5部：Terraformライフサイクル破壊編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)**|なぜTerraformはAnsibleが投じた設定を知らないのか|TerraformのState管理メカニズムと、Ansibleが変更するコンテナ内部状態の「認識の不可視性」を解剖する根本解説回。|
|**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)**|`create_before_destroy`や`replace_triggered_by`による強制再生成|HCLのライフサイクル制御（`lifecycle`ブロック）によって強制再生成（ForceNew）が発生し、Ansibleの設定が消し飛ぶ現象の再現。|
|**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)**|`prevent_destroy`設定時におけるAnsibleプロビジョニングの詰まり|誤破壊防止の`prevent_destroy`と、Ansibleの再実行（再プロビジョニング）要求がバッティングしてデプロイが詰まる障害。|
|**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)**|リソース再生成に伴うAnsible生成データの全喪失（データ消失障害）|Terraform側がリソースを破棄、再生成（Destroy & Create）した際、Ansibleで作成したデータベースやファイルなどの状態が全消去される問題。|
|**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)**|ネットワークや依存リソースの変更に引きずられる連鎖的再生成|依存関係にあるネットワーク（Docker Network）や上位リソースの変更により、ターゲット全体が連鎖破壊される現象。|
|**[第46回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-46/)**|プロビジョニング途中の接続切断とState不整合（ハーフデプロイ状態）|Ansible実行中に接続が切断、エラー停止した際、TerraformのStateが「作成完了」と「プロビジョニング未完了」の半端な状態になる問題。|
|**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)**|ステートフルなデータ（Volume/DB）を保持しながらの安全な再構築|内部データをDocker Volumeに分離し、コンテナ（リソース）が再生成されてもAnsibleの投入データを生かす設計。|
|**[第48回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/)**|イミュータブルインフラストラクチャにおけるAnsibleの限定的役割|「実行時にAnsibleで設定する」のを取りやめ、ビルド時にAnsibleを組み込んでコンテナイメージを焼き込む運用へのシフト。|
|**[第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)**|CI/CD環境において再構築事故を物理的に防ぐパイプラインガード|GitHub Actions等で誤ってDestroy & Createが走らないよう、`terraform plan`の差分ログを解析して自動ブロックするガードレール設計。|
|**[第50回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-50/)**|連載総括：Ansible×Terraformを共存させる「ツール境界線」の設計原則|50回を通じた結論。「どこまでをTerraformに任せ、どこからをAnsibleに委ねるか」の境界線（アンチパターンと原則）のまとめ。|

---

[↑ 目次に戻る](#-目次)

---

