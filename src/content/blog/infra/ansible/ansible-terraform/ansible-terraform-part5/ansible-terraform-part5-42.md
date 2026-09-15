---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第42回：`create_before_destroy`や`replace_triggered_by`による強制再生成'
description: '`lifecycle`ブロックの`create_before_destroy`と`replace_triggered_by`という2つの再生成トリガーを整理し、リソースの強制再生成によってAnsibleが投じたコンテナ内部の設定が消失する現象を実機で再現する。この消失が「認識の不可視性」の必然的な帰結であることを示す。'
pubDate: 2026-09-15
category: 'infra'
tags: ['Ansible', 'Terraform', 'lifecycle', 'create_before_destroy', 'replace_triggered_by']
seriesId: 'ansible-terraform-part5'
seriesNo: 42
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/'
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
2. [属性変更によるForceNew相当の再生成](#2-属性変更によるforcenew相当の再生成)
3. [create_before_destroyによる再生成順序の制御](#3-create_before_destroyによる再生成順序の制御)
4. [replace_triggered_byによる明示的な再生成トリガー](#4-replace_triggered_byによる明示的な再生成トリガー)
5. [再生成時にAnsibleの設定が消える理由](#5-再生成時にansibleの設定が消える理由)
6. [実機再現：再生成前後の状態比較](#6-実機再現再生成前後の状態比較)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

HCLのコードをほんの少し書き換えただけなのに、コンテナがまるごと作り直されてしまった、という経験はないでしょうか。

**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** では、`terraform show`によるtfstateの記録内容の確認と、`terraform plan`による2つの対照的な変更の検証を通じて、Terraformが管理するのはリソース属性のみであり、コンテナ内部のOS状態はそもそも観測対象に含まれていないことを確認しました。そのうえで、この構造を「認識の不可視性」という軸として整理し、この不可視性は通常運用では無害である一方、`lifecycle`ブロックによる強制再生成のような、Terraformがリソースを破棄、再生成する操作をきっかけに、「保護されない」という状態に転じることを示しました。

第42回となる今回は、この不可視性が実際に「破壊」として表面化する最初の具体例を扱います。「属性を少し変えただけなのに、コンテナが丸ごと作り直される」という現象がなぜ起きるのかを整理することが、この回の目的です。

Terraformのリソース属性には、更新（in-place update）が可能な属性と、変更するとリソースの削除、再作成が必要になる属性があります。加えて`lifecycle`ブロックを使えば、この再生成を明示的に指示することもできます。この回では、`create_before_destroy`と`replace_triggered_by`という2つの異なる仕組みによって、リソースが「更新」ではなく「破棄、再生成」として扱われる構造を整理し、その際にAnsibleが投じたコンテナ内部の設定が実際に消し飛ぶ様子を実機で再現します。

次のセクションでは、`lifecycle`ブロックを使わない、素の再生成の挙動から確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 属性変更によるForceNew相当の再生成

`lifecycle`ブロックを使わない、素の再生成の挙動をまず確認します。

`docker_container`リソースの中には、プロバイダーの実装上、in-placeでの更新に対応していない属性があります。target-node1にAnsibleで配置した設定が、こうした属性の変更をきっかけに実際に失われる様子を、この回を通じて段階的に確認していきます。

### ■ 検証内容：Ansibleによる設定投入

まず、target-node1にAnsibleでマーカーファイルを配置し、稼働状態にします。

* **ファイル名：`playbooks/lifecycle_marker.yml`（新規作成）**

```yaml
---
- name: 第42回検証用マーカー配置Playbook
  hosts: target-node1
  gather_facts: false
  become: true

  tasks:
    - name: ライフサイクル検証用マーカーファイルを配置
      ansible.builtin.copy:
        dest: /etc/lifecycle_test_marker.txt
        content: "created_by=ansible\n"
```

**実行コマンド**

```plaintext
ansible-playbook -i ../docker-lab/inventory.ini playbooks/lifecycle_marker.yml
```

**▼ 実行結果**

```plaintext
PLAY [第42回検証用マーカー配置Playbook] *****************************************************************************************************************************************************

TASK [ライフサイクル検証用マーカーファイルを配置] *******************************************************************************************************************************************
changed: [target-node1]

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

配置内容を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "cat /etc/lifecycle_test_marker.txt"
```

**▼ 実行結果**

```plaintext
created_by=ansible
```

target-node1に、Ansibleが投じた設定として`/etc/lifecycle_test_marker.txt`が存在する状態になりました。

### ■ 検証内容：`name`属性の変更

続いて、`docker_container.targets`の`name`属性を変更します。target-node1は`for_each`によって`local.target_nodes`のキーから生成されているため、キー自体を変更するとリソースのアドレスそのものが変わってしまいます。ここでは、リソースのアドレス（`docker_container.targets["target-node1"]`）は維持したまま、`name`属性の値のみを変更します。

* **ファイル名：`main.tf`（該当箇所）**

**【変更前】**

```hcl
resource "docker_container" "targets" {
  for_each = local.target_nodes
  name     = each.key
  # 以下略
}
```

**【変更後】**

```hcl
resource "docker_container" "targets" {
  for_each = local.target_nodes
  name     = each.key == "target-node1" ? "target-node1-renamed" : each.key
  # 以下略
}
```

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
      ~ hostname                                    = "4b64570ba7c4" -> (known after apply)
      ~ id                                          = "4b64570ba7c44929aa21c195ea306c2020b1381dc5397f2c655aa5b2eb0256e1" -> (known after apply)
      ~ init                                        = false -> (known after apply)
      ~ ipc_mode                                    = "private" -> (known after apply)
      ~ log_driver                                  = "json-file" -> (known after apply)
      - log_opts                                    = {} -> null
      - max_retry_count                             = 0 -> null
      - memory                                      = 0 -> null
      - memory_swap                                 = 0 -> null
      ~ name                                        = "target-node1" -> "target-node1-renamed" # forces replacement
      ~ network_data                                = [
          - {
              - gateway                   = "172.20.0.1"
              - global_ipv6_prefix_length = 0
              - ip_address                = "172.20.0.2"
              - ip_prefix_length          = 24
              - mac_address               = "32:70:c2:f1:25:40"
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

        # (4 unchanged blocks hidden)
    }

（途中省略：local_file.ansible_inventory、local_file.group_vars_target_nodesの再作成計画）

Plan: 3 to add, 0 to change, 3 to destroy.

（途中省略：Changes to Outputs）

Note: You didn't use the -out option to save this plan, so Terraform can't guarantee to take exactly these actions if you run "terraform apply" now.
```

### ■ 結果

`docker_container.targets["target-node1"] must be replaced`という見出しとともに、`-/+`（destroy and then create replacement）の記号が表示されました。差分の中でも`~ name = "target-node1" -> "target-node1-renamed" # forces replacement`という行が、この再生成を引き起こしている直接の原因です。

`lifecycle`ブロックは一切追加していません。`docker_container`が`name`属性の変更をin-placeでの更新に対応していないという、プロバイダー側の実装上の性質だけで、Terraformは自動的に「更新」ではなく「破棄、再作成」を計画しています。`network_data`や`network_mode`といった、`name`とは直接関係のない属性まで`-`（削除）や`(known after apply)`として表示されているのも、この再作成がコンテナ全体を作り直す操作であることを示しています。

次のセクションでは、この再生成の順序を制御する`create_before_destroy`を扱います。

---

[↑ 目次に戻る](#-目次)

---

## 3. `create_before_destroy`による再生成順序の制御

再生成の順序を制御する`lifecycle`設定を確認します。

`create_before_destroy = true`を設定すると、古いリソースを破棄する前に新しいリソースを先に作成する順序に変わります。この機能はダウンタイムの短縮を目的としていますが、まず実機でこの設定を試みます。

### ■ 検証内容：`create_before_destroy`の追加

`docker_container.targets`の`lifecycle`ブロックに、`create_before_destroy = true`を追加します。

* **ファイル名：`main.tf`（該当箇所）**

**【変更前】**

```hcl
  lifecycle {
    ignore_changes = [network_mode]
  }
```

**【変更後】**

```hcl
  lifecycle {
    create_before_destroy = true
    ignore_changes         = [network_mode]
  }
```

セクション2で加えた`name`属性の変更（`target-node1`のみ`"target-node1-renamed"`になる条件式）はそのまま維持し、この状態で`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement
+/- create replacement and then destroy

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] must be replaced
+/- resource "docker_container" "targets" {
      （途中省略：属性の差分詳細）
      ~ name                                        = "target-node1" -> "target-node1-renamed" # forces replacement
        （途中省略：network_data等の差分詳細）
    }

（途中省略：local_file.ansible_inventory、local_file.group_vars_target_nodesの再作成計画）

Plan: 3 to add, 0 to change, 3 to destroy.

（途中省略：Changes to Outputs）

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

（途中省略：local_fileの破棄完了ログ）

docker_container.targets["target-node1"]: Creating...
╷
│ Error: Unable to start container: Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint target-node1-renamed (26c2816f44978a3266c99c2de2f220067851f4f79c8b66a58259cc615381748c): Bind for 0.0.0.0:2231 failed: port is already allocated
│
│   with docker_container.targets["target-node1"],
│   on main.tf line 82, in resource "docker_container" "targets":
│   82: resource "docker_container" "targets" {
│
╵
```

### ■ 結果

`Symbols`に`+/- create replacement and then destroy`という表示が追加されました。これは、セクション2で確認した`-/+ destroy and then create replacement`（破棄してから作成）とは順序が逆であることを示しています。`create_before_destroy = true`により、Terraformは実際に新しいコンテナ（`target-node1-renamed`）の作成を先に試みました。

しかし、この作成は`port is already allocated`というエラーで失敗しました。target-node1は外部ポート`2231`を固定で使用する設定（`ports { external = each.value }`）になっており、旧コンテナ（稼働中の`target-node1`）がまだこのポートを保持したままの状態で、新しいコンテナ（`target-node1-renamed`）も同じポート`2231`を要求したためです。

`create_before_destroy`は、新旧のリソースが同時に存在する瞬間を作り出す仕組みです。この瞬間、両者が同じホストリソース（ここでは外部ポート）を取り合うことになり、片方しか確保できません。ダウンタイムを短縮するために新しいリソースを先に作るという設計そのものが、固定のポートや固定の名前を持つリソースでは、逆に新規作成を失敗させる原因になります。

`docker_container.targets`は`name`も`ports.external`も固定値で定義されているため、この検証環境では`create_before_destroy`をそのままの形で有効にすることはできません。次のセクションでは、`replace_triggered_by`による、別の角度からの再生成トリガーを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 4. `replace_triggered_by`による明示的な再生成トリガー

依存関係を明示的に再生成条件へ組み込む機能を示します。

`replace_triggered_by`はTerraform 1.2で導入された機能で、参照先リソースの変更を検知して、直接は変更されていない別のリソースまで再生成の対象にできます。

### ■ 検証内容：target-node1〜3全台へのAnsible設定投入

この回の検証は`for_each`で一括管理されている3台すべてに影響するため、セクション2、3のPlaybookを3台対象に変更します。

* **ファイル名：`playbooks/lifecycle_marker.yml`（該当箇所）**

**【変更前】**

```yaml
  hosts: target-node1
```

**【変更後】**

```yaml
  hosts: target_nodes
```

**実行コマンド**

```plaintext
ansible-playbook -i ../docker-lab/inventory.ini playbooks/lifecycle_marker.yml
```

**▼ 実行結果**

```plaintext
PLAY [第42回検証用マーカー配置Playbook] *****************************************************************************************************************************************************

TASK [ライフサイクル検証用マーカーファイルを配置] *******************************************************************************************************************************************
ok: [target-node2]
ok: [target-node1]
changed: [target-node3]

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

配置内容を3台とも確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "cat /etc/lifecycle_test_marker.txt"
docker exec -it target-node2 bash -c "cat /etc/lifecycle_test_marker.txt"
docker exec -it target-node3 bash -c "cat /etc/lifecycle_test_marker.txt"
```

**▼ 実行結果**

```plaintext
created_by=ansible
created_by=ansible
created_by=ansible
```

target-node1〜3すべてに、Ansibleが投じた設定として`/etc/lifecycle_test_marker.txt`が存在する状態になりました。

### ■ 検証内容：`replace_triggered_by`の設定

`docker_container.targets`の`upload`ブロックの1つは、`tls_private_key.generated`が生成した公開鍵を参照しています。

* **ファイル名：`main.tf`（該当箇所、96〜99行目）**

```hcl
  upload {
    file    = "/home/ansible/.ssh/authorized_keys"
    content = "${file("${path.module}/id_ed25519.pub")}\n${tls_private_key.generated.public_key_openssh}"
  }
```

`content`の中に`tls_private_key.generated.public_key_openssh`という参照があり、target-node1〜3はこの鍵を使ってAnsibleからのSSH接続を受け付けています。この参照関係を`lifecycle`ブロックの`replace_triggered_by`に明示的に指定します。

* **ファイル名：`main.tf`（該当箇所）**

**【変更前】**

```hcl
  lifecycle {
    ignore_changes = [network_mode]
  }
```

**【変更後】**

```hcl
  lifecycle {
    replace_triggered_by = [tls_private_key.generated]
    ignore_changes         = [network_mode]
  }
```

`docker_container.targets`は`for_each`によってtarget-node1〜3を一括生成しているため、この`lifecycle`ブロックはインスタンスごとに個別指定できません。したがって、`replace_triggered_by`の対象は3台すべてに一律で適用されます。

この状態で、`tls_private_key.generated`を意図的に再生成させます。

**実行コマンド**

```plaintext
terraform taint tls_private_key.generated
```

**▼ 実行結果**

```plaintext
Resource instance tls_private_key.generated has been marked as tainted.
```

`terraform plan`を実行し、影響範囲を確認します。

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

  # docker_container.targets["target-node1"] will be replaced due to changes in replace_triggered_by
-/+ resource "docker_container" "targets" {
      （途中省略：属性の差分詳細）
      - upload { # forces replacement
          - content        = <<-EOT
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ9ZflEAp+DdFuvvm/+Y7HhfCtg0n51gm5xN4IfNH9aM control@ubuntu-controller

                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBNq1AJD66jrCFzItazhDFMeajO6eQmK6S5Eb//xB8aB
            EOT -> null
          - executable     = false -> null
          - file           = "/home/ansible/.ssh/authorized_keys" -> null
            # (3 unchanged attributes hidden)
        }
      + upload { # forces replacement
          + content        = (known after apply)
          + executable     = false
          + file           = "/home/ansible/.ssh/authorized_keys"
            # (3 unchanged attributes hidden)
        }

        # (3 unchanged blocks hidden)
    }

  # docker_container.targets["target-node2"] will be replaced due to changes in replace_triggered_by
-/+ resource "docker_container" "targets" {
      （途中省略：target-node1と同様の差分詳細）
    }

  # docker_container.targets["target-node3"] will be replaced due to changes in replace_triggered_by
-/+ resource "docker_container" "targets" {
      （途中省略：target-node1と同様の差分詳細）
    }

（途中省略：local_file.ansible_inventory、local_file.group_vars_target_nodes、local_file.private_keyの再作成計画）

  # tls_private_key.generated is tainted, so must be replaced
-/+ resource "tls_private_key" "generated" {
      （途中省略：属性の差分詳細）
    }

Plan: 7 to add, 0 to change, 7 to destroy.

（途中省略：Changes to Outputs）
```

### ■ 結果

`docker_container.targets["target-node1"]`・`["target-node2"]`・`["target-node3"]`のすべてに、`will be replaced due to changes in replace_triggered_by`という表示が出ました。この3台はいずれも、`name`属性や`image`属性を直接変更していません。`tls_private_key.generated`という、`upload`ブロック経由で間接的に参照しているリソースの再生成だけをきっかけに、3台とも再生成対象になっています。

セクション3の`create_before_destroy`は、あくまで既存の再生成が発生する順序を制御する仕組みでした。一方この`replace_triggered_by`は、それ自体が新たな再生成のきっかけを作り出す仕組みです。参照先リソースを1つ変更するだけで、直接は無関係なリソースまで連鎖的に再生成対象へ広げられる点が、この機能の性質です。

この状態で`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Planの再掲、yes確認）

local_file.group_vars_target_nodes: Destroying... [id=b6076259ecbd8f04782c0d07e935eba30d3304d6]
local_file.private_key: Destroying... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
local_file.private_key: Destruction complete after 0s
local_file.ansible_inventory: Destroying... [id=e0da642b7a64204431802e5779b849f01cae63a3]
local_file.group_vars_target_nodes: Destruction complete after 0s
local_file.ansible_inventory: Destruction complete after 0s
docker_container.targets["target-node2"]: Destroying... [id=a0a321ac38928285dfb905f694b57882fd1a1df0dc86a7fa46b9eddb0488f0bc]
docker_container.targets["target-node1"]: Destroying... [id=ea79df20904819216bdb38a3d2dfc3eb11e866e6987dcc5bad602b89eeb089c9]
docker_container.targets["target-node3"]: Destroying... [id=74e95d924c505327a94ec513b053fa9723bb1618b368411f568041844ba7b9a1]
docker_container.targets["target-node1"]: Destruction complete after 2s
docker_container.targets["target-node2"]: Destruction complete after 2s
docker_container.targets["target-node3"]: Destruction complete after 2s
tls_private_key.generated: Destroying... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
tls_private_key.generated: Destruction complete after 0s
tls_private_key.generated: Creating...
tls_private_key.generated: Creation complete after 0s [id=024a635616465ce17e5b5d2914cd39abefe64dc6]
local_file.private_key: Creating...
local_file.private_key: Creation complete after 1s [id=91e36e11aabd765368c656ace1ae91321b9df278]
docker_container.targets["target-node2"]: Creating...
docker_container.targets["target-node3"]: Creating...
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node1"]: Creation complete after 4s [id=823e3e1895d37a8554e014dabf5b47a70413843954755bc667c24c9ab96477e5]
docker_container.targets["target-node3"]: Creation complete after 5s [id=57a98bce45f31093768e32c07b51d18648afb76bb9f05fe0e6385ba1a87f88d4]
docker_container.targets["target-node2"]: Creation complete after 5s [id=553df1c0a05cc234d1090712ef15b32f59bad941bc77375dce41a18f178def14]
local_file.ansible_inventory: Creating...
local_file.group_vars_target_nodes: Creating...
local_file.ansible_inventory: Creation complete after 0s [id=e0da642b7a64204431802e5779b849f01cae63a3]
local_file.group_vars_target_nodes: Creation complete after 0s [id=b6076259ecbd8f04782c0d07e935eba30d3304d6]

Apply complete! Resources: 7 added, 0 changed, 7 destroyed.
```

target-node1〜3がすべて新しいコンテナとして再作成されたことを確認したうえで、事前に配置していたマーカーファイルの有無を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "cat /etc/lifecycle_test_marker.txt 2>&1"
docker exec -it target-node2 bash -c "cat /etc/lifecycle_test_marker.txt 2>&1"
docker exec -it target-node3 bash -c "cat /etc/lifecycle_test_marker.txt 2>&1"
```

**▼ 実行結果**

```plaintext
cat: /etc/lifecycle_test_marker.txt: No such file or directory
cat: /etc/lifecycle_test_marker.txt: No such file or directory
cat: /etc/lifecycle_test_marker.txt: No such file or directory
```

3台とも、Ansibleが配置したマーカーファイルが失われています。SSH鍵という、`docker_container`の属性とは一見無関係なリソースの再生成をきっかけに、直接変更していない3台すべてで、Ansibleが投じた設定が消失しました。

`create_before_destroy`が固定の名前やポートを持つリソースと衝突したのに対し、`replace_triggered_by`は参照関係を明示的に組み込める分、影響範囲を意図せず広げやすいという性質が、この結果から確認できます。次のセクションでは、これまでの検証を踏まえ、再生成時にAnsibleの設定が消える理由を構造的に整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. 再生成時にAnsibleの設定が消える理由

セクション2〜4で確認した再生成が、なぜAnsibleの設定消失につながるのかを整理します。

**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** で整理した通り、tfstateが記録するのはTerraformが管理するリソース属性のみであり、コンテナ内部にAnsibleが投じたファイルやパッケージの状態は、そもそも記録する場所自体がありません。この前提に立つと、リソースが再生成された際、新しいリソースにAnsibleの設定を復元する仕組みは、Terraform側に存在しないことになります。

セクション2〜4で確認した3つの再生成は、いずれも起点となる属性やトリガーが異なりますが、消失に至る経路は共通しています。

```
【セクション2、3：name属性の変更】
name属性の変更 → docker_containerの更新不可属性に該当 → 破棄、再作成
　→ 新しいコンテナはAnsible未設定の状態で作られる

【セクション4：replace_triggered_by】
tls_private_key.generatedの再生成 → replace_triggered_byによりtarget-node1〜3が再生成対象に
　→ 新しいコンテナはAnsible未設定の状態で作られる
```

いずれの経路でも、Terraformが実際に行っている処理は同じです。古いコンテナを破棄し、`main.tf`のリソース定義（`image`、`ports`、`upload`ブロック等）に基づいて新しいコンテナを作成します。この`upload`ブロックには、セクション4で確認した通りSSH公開鍵と`/etc/init_marker`が含まれていますが、Ansibleが実行時に投じた`/etc/lifecycle_test_marker.txt`のような設定は、この定義のどこにも記述されていません。そのため、再生成後のコンテナには反映のしようがありません。

ここで重要なのは、この一連の処理が`terraform apply`の観点では正常に完了しているという点です。セクション2、3、4のいずれの`Apply complete`ログにも、エラーや警告は含まれていません。

```
【Terraformから見た再生成】
古いリソースの破棄 → 新しいリソースの作成（HCLコードの定義通り）
　→ tfstateの更新は正常に完了（エラーなし）

【実際に起きていること】
古いコンテナ（Ansible設定済み） → 新しいコンテナ（Ansible設定なし）
　→ Terraformの認識範囲外の情報のため、消失そのものが検知されない
```

`terraform apply`は、HCLコードに書かれた定義通りにリソースを作り直すという、指示された作業を正確に実行しています。Ansibleが投じた設定の消失は、この作業のバグや不具合ではなく、**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** で整理した「認識の不可視性」が、リソースの破棄、再生成という操作をきっかけに、具体的な消失という形で表面化した結果です。

次のセクションでは、この回の総仕上げとして、再生成前後の状態を1つの流れとして直接比較します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 実機再現：再生成前後の状態比較

この回の総仕上げとして、再生成前後の状態を直接比較します。

セクション2〜5では、コンテナの再生成そのものと、その理由の構造を確認しました。このセクションでは、Ansibleが投じたファイルに加えてパッケージも対象に含め、再生成前後の状態をひとつの流れとして直接比較します。

### ■ 検証内容：再生成前のAnsible設定投入

target-node1に対し、Ansibleでファイル配置とパッケージインストールを行います。

* **ファイル名：`playbooks/lifecycle_marker.yml`（該当箇所）**

```yaml
---
- name: 第42回検証用マーカー配置Playbook
  hosts: target-node1
  gather_facts: false
  become: true

  tasks:
    - name: ライフサイクル検証用マーカーファイルを配置
      ansible.builtin.copy:
        dest: /etc/lifecycle_test_marker.txt
        content: "created_by=ansible\n"
    - name: 検証用パッケージをインストール
      ansible.builtin.apt:
        name: tree
        state: present
        update_cache: true
```

**実行コマンド**

```plaintext
ansible-playbook -i ../docker-lab/inventory.ini playbooks/lifecycle_marker.yml
```

**▼ 実行結果**

```plaintext
PLAY [第42回検証用マーカー配置Playbook] *****************************************************************************************************************************************************

TASK [ライフサイクル検証用マーカーファイルを配置] *******************************************************************************************************************************************
changed: [target-node1]

TASK [検証用パッケージをインストール] *******************************************************************************************************************************************************
changed: [target-node1]

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 検証内容：再生成前の状態確認

ファイル、パッケージがともに存在することを確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "cat /etc/lifecycle_test_marker.txt"
docker exec -it target-node1 bash -c "which tree && tree --version"
```

**▼ 実行結果**

```plaintext
created_by=ansible
/usr/bin/tree
tree v2.0.2 (c) 1996 - 2022 by Steve Baker, Thomas Moore, Francesc Rocher, Florian Sesser, Kyosuke Tokoro
```

target-node1に、Ansibleが投じた設定として、ファイル（`/etc/lifecycle_test_marker.txt`）とパッケージ（`tree`）の両方が存在する状態になりました。

### ■ 検証内容：再生成の実行

セクション2と同じ形で、`name`属性の変更により再生成を発生させます。

* **ファイル名：`main.tf`（該当箇所）**

**【変更前】**

```hcl
  name     = each.key
```

**【変更後】**

```hcl
  name     = each.key == "target-node1" ? "target-node1-renamed" : each.key
```

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] must be replaced
-/+ resource "docker_container" "targets" {
      （途中省略：属性の差分詳細）
      ~ name                                        = "target-node1" -> "target-node1-renamed" # forces replacement
        （途中省略：network_data等の差分詳細）
    }

（途中省略：local_file.ansible_inventory、local_file.group_vars_target_nodesの再作成計画）

Plan: 3 to add, 0 to change, 3 to destroy.

（途中省略：Changes to Outputs）

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

（途中省略：local_fileの破棄、作成完了ログ）

docker_container.targets["target-node1"]: Destroying... [id=823e3e1895d37a8554e014dabf5b47a70413843954755bc667c24c9ab96477e5]
docker_container.targets["target-node1"]: Destruction complete after 1s
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node1"]: Creation complete after 1s [id=2af55a91e57cb775348dd557a971c7d3452eb034c250c1a87f77b870e595f005]

（途中省略：local_file作成完了ログ）

Apply complete! Resources: 3 added, 0 changed, 3 destroyed.
```

### ■ 検証内容：再生成後の状態確認

再生成後のコンテナ名を確認したうえで、同じファイル、パッケージの有無を確認します。

**実行コマンド**

```plaintext
docker ps -a | grep -i target-node1
```

**▼ 実行結果**

```plaintext
2af55a91e57c   32ab5c4e8d48   "/usr/sbin/sshd -D"   About a minute ago   Up About a minute   0.0.0.0:2231->22/tcp   target-node1-renamed
```

`docker_container.targets["target-node1"]`というtfstate上のアドレスは変わっていませんが、コンテナの実体は`target-node1-renamed`という新しい名前で作り直されています。このコンテナに対し、ファイルとパッケージの存在を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1-renamed bash -c "cat /etc/lifecycle_test_marker.txt 2>&1"
docker exec -it target-node1-renamed bash -c "which tree; echo exit_code=\$?"
```

**▼ 実行結果**

```plaintext
cat: /etc/lifecycle_test_marker.txt: No such file or directory
exit_code=1
```

### ■ 結果

ファイル（`/etc/lifecycle_test_marker.txt`）は`No such file or directory`となり、パッケージ（`tree`）は`which`が何も返さず終了コード`1`となりました。いずれもAnsibleが投じた設定であり、再生成前には確かに存在していたものです。

`terraform apply`自体は、セクション2、3、4のいずれと同様、エラーや警告を一切出さずに`Apply complete`として完了しています。コンテナというリソースの再生成としては、この処理は完全に正常です。しかし、その内部にAnsibleが投じたファイルとパッケージは、種類を問わずどちらも、この正常な処理の中で静かに失われています。

セクション2から5にかけて整理してきた通り、この消失は特定の操作や特定の設定内容に固有の現象ではありません。`name`属性の変更（セクション2、3）でも、`replace_triggered_by`によるトリガー（セクション4）でも、再生成が発生した先には同じ結果が待っています。ファイルであれパッケージであれ、Ansibleがコンテナ内部に投じたものは、すべてtfstateの記録範囲の外側にあり、再生成のたびに保護も引き継ぎもされません。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* `docker_container`の`name`属性のような、プロバイダー側でin-place更新に対応していない属性を変更すると、`lifecycle`ブロックを使わなくてもTerraformは自動的に破棄、再作成を計画することを実機で確認した
* `create_before_destroy = true`は、破棄より先に新しいリソースの作成を試みる順序に変える。しかし固定の外部ポートを持つリソースでは、新旧が同時に存在する瞬間にホストポートが競合し、作成そのものが失敗することを実機で確認した
* `replace_triggered_by`は、参照先リソースの変更を検知して、直接は変更していない別のリソースまで再生成対象にできる。`for_each`で複数インスタンスを一括生成しているリソースでは、`lifecycle`ブロックをインスタンスごとに個別指定できないため、影響範囲が意図した1台にとどまらず、全インスタンスに一律で及ぶことを実機で確認した
* いずれの再生成も、Terraformにとっては`main.tf`の定義通りにリソースを作り直すという正常な処理であり、`terraform apply`はエラーや警告を出さずに完了する。この正常な処理の中で、Ansibleが投じたファイルとパッケージは、種類を問わずどちらも保護されずに失われることを実機で確認した
* この消失は、**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** で整理した「認識の不可視性」が、リソースの破棄、再生成という操作をきっかけに、具体的な事象として表面化した結果である

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

第42回となる今回は、**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** で整理した「認識の不可視性」が実際に「破壊」として表面化する最初の具体例として、`lifecycle`ブロックによる強制再生成を扱いました。属性変更による素の再生成、`create_before_destroy`による順序制御、`replace_triggered_by`による明示的なトリガーという3つの角度から、それぞれ異なる制約と挙動を実機で確認したうえで、いずれの経路でも再生成後のコンテナからAnsibleが投じたファイル、パッケージが失われることを実機で再現しました。

次回は、この強制再生成とは逆に、リソースの誤った破棄を防ぐための`prevent_destroy`が、Ansibleの再実行要求とかみ合わずにデプロイそのものを詰まらせてしまう問題を扱います。

**[次回：第43回：`prevent_destroy`設定時におけるAnsibleプロビジョニングの詰まり](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)　｜　[次の記事：【Ansible×Terraform編】第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第5部まとめブログ：Terraformライフサイクル破壊編で明らかになった「認識の不可視性」の構造** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

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

