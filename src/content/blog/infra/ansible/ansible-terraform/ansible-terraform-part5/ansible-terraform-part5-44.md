---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第44回：リソース再生成に伴うAnsible生成データの全喪失（データ消失障害）'
description: 'Terraformによるリソースの破棄、再生成が、Ansibleが投じた静的な設定だけでなく、稼働中に生成され続ける動的なデータをも消し去る構造を整理する。コンテナのファイルシステムのライフサイクルという観点から、設定の消失とデータの消失の被害の質の違いを実機で確認する。'
pubDate: 2026-09-16
category: 'infra'
tags: ['Ansible', 'Terraform', 'lifecycle', 'replace_triggered_by', 'データ消失']
seriesId: 'ansible-terraform-part5'
seriesNo: 44
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/'
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
2. [コンテナのファイルシステムのライフサイクル](#2-コンテナのファイルシステムのライフサイクル)
3. [仮想マシンにおけるライフサイクル](#3-仮想マシンにおけるライフサイクル)
4. [「設定」と「データ」の区別](#4-設定とデータの区別)
5. [実機再現：再生成によるデータ喪失](#5-実機再現再生成によるデータ喪失)
6. [Terraform側から見た「正常終了」との対比](#6-terraform側から見た正常終了との対比)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

Terraformによるリソースの再生成で消えるのは、Ansibleが配置した設定ファイルやインストールしたパッケージだけだと考えていないでしょうか。

**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** では、`lifecycle`ブロックによる強制再生成によって、Ansibleが投じた設定（ファイル配置、パッケージ導入）が消失することを実機で確認しました。**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)** では、この再生成そのものを`prevent_destroy`で止めようとすると、デプロイパイプラインが詰まるという、別の障害に置き換わるだけであることを確認しました。

第44回となる今回は、この2つを踏まえたうえで視点を進めます。「再生成を許容せざるを得ない場面で、消えるものが設定ファイル程度で済むとは限らない」という、より深刻なケースです。

**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で扱ったのは、投入した時点の状態が固定的な、静的な設定でした。しかし、稼働中のコンテナ内部では、Ansibleやアプリケーション自身が生成し続ける動的なデータも同様に存在します。データベースのレコード、ログ、アップロードされたファイルといったものです。こうしたデータも、コンテナのファイルシステム上に存在する限り、再生成によって同じ運命をたどります。

この回で扱う問いは、「なぜコンテナを再生成すると、内部で生成されたデータまで跡形もなく消えるのか」です。

次のセクションでは、この問いの技術的な土台となる、コンテナのファイルシステムのライフサイクルを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. コンテナのファイルシステムのライフサイクル

データ消失の技術的な土台を整理します。

Dockerコンテナのファイルシステムは、コンテナのライフサイクルに紐づいています。`docker_container`リソースが破棄されると、コンテナ本体とともに、その書き込み可能レイヤーも削除されます。Volumeマウント等によって明示的に外部化されていない限り、コンテナ内部で生成されたデータは、すべてこの書き込み可能レイヤー上に存在します。
```

【Volume未使用の場合】  
コンテナの書き込み可能レイヤー  
　├─ Ansibleが配置したファイル  
　├─ Ansibleがインストールしたパッケージ  
　└─ 稼働後にアプリケーションが生成したデータ  
　　　→ すべてコンテナと運命をともにする

```

**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** で整理した通り、tfstateが記録するのはリソース属性のみであり、コンテナ内部のファイルシステムの状態はそもそも観測対象に含まれていません。この構造は、Ansibleが配置した静的な設定ファイルにも、稼働後に生成される動的なデータにも、区別なく及びます。書き込み可能レイヤーの中身がどのような性質のデータであるかは、Terraform側にとって関係がありません。コンテナというリソースが破棄されれば、レイヤーごとすべてが失われます。

次のセクションでは、この構造がコンテナに限らず、仮想マシン環境ではどのような形をとるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. 仮想マシンにおけるライフサイクル

セクション2で確認したコンテナのライフサイクルが、仮想マシン（VM）環境ではどのような構造になるかを整理します。

### ■ 「停止」と「終了」の違い

VM環境では、インスタンスに対する操作が「停止」と「終了」に分かれており、この2つは意味が異なります。

AWS EC2を例にすると、インスタンスを停止した場合、ルートデバイスや他のアタッチされたデバイスは保持されます。一方、インスタンスを終了した場合、`DeleteOnTermination`属性が`true`に設定されたアタッチ済みEBSボリュームは自動的に削除されます。つまり、「終了」という操作に限って、ルートボリュームの削除が発生する構造になっています。

* **停止（stop）**：インスタンスは一時的に稼働を止めるが、ルートボリュームを含む各ディスクは保持される
* **終了（terminate）**：インスタンス自体が削除され、ルートボリュームもデフォルト設定に従って削除される

コンテナ環境では「停止」と「削除」がそれぞれ独立した操作として区別されますが、VM環境では「終了」という単一の操作が、インスタンスの削除とルートボリュームの削除を同時に引き起こす点が異なります。

### ■ ルートボリュームのデフォルト設定

AWS EC2では、ルートボリューム（EBS）の`DeleteOnTermination`属性はデフォルトで`true`に設定されています。GCP Compute Engineでも同様に、新しいVMインスタンスのブートディスクはデフォルトで自動削除されるよう設定されています。

いずれの環境も、この設定はユーザー側で変更可能です。EC2では`DeleteOnTermination`を`false`に設定すればルートボリュームを保持でき、GCP Compute Engineでは`autoDelete`を`false`に設定すれば同様にブートディスクを保持できます。しかし、明示的に変更しない限り、インスタンスの終了とともにルートボリュームも削除されるというのが、両クラウドプロバイダーに共通するデフォルトの挙動です。
```

【VM環境（AWS EC2、GCP Compute Engine等）】  
インスタンスの終了  
　↓  
ルートボリューム（ブートディスク）もデフォルト設定に従って削除  
　→ Volume等で明示的に永続化されていない限り、  
　　インスタンス内部で生成されたデータも同様に失われる

```

### ■ コンテナとの構造的な共通点

セクション2で整理したコンテナのライフサイクルと対比すると、両者は実装方式が異なるだけで、構造としては同じ性質を持っています。
```

【コンテナ】  
Volumeマウント（未使用）→ 書き込み可能レイヤーがコンテナと運命をともにする  
Volumeマウント（使用） → 該当データはコンテナのライフサイクルから切り離される

【VM】  
ボリューム設定（デフォルト）→ ルートボリュームがインスタンスの終了と運命をともにする  
ボリューム設定（変更） → 該当データはインスタンスのライフサイクルから切り離される

```

どちらの環境でも、データをリソースのライフサイクルから切り離す手段（コンテナのVolumeマウント、VMの`DeleteOnTermination`/`autoDelete`設定変更）が用意されている一方、その手段を明示的に使わない限り、デフォルトの挙動としてはリソースの破棄、終了とともにデータも失われます。この構造は、実装方式（コンテナかVMか）やクラウドプロバイダー（AWSかGCPか）に依存しない、Terraformが管理するリソースのライフサイクル一般に共通する性質です。

なお、本シリーズの検証環境（Docker）では、以降のセクションで扱う実機再現はコンテナを対象に行います。VM環境については、上記の通り概念レベルでの整理にとどめます。

次のセクションでは、この対比を踏まえたうえで、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で扱った「設定」と、この回で扱う「データ」の区別を整理します。

---

[↑ 目次に戻る](#-目次)

---


## 4. 「設定」と「データ」の区別

セクション2、セクション3で確認した対象がコンテナか仮想マシンかを問わず、この回で扱う問題の核心は、リソース内部に存在するものの性質にあります。**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で扱った内容とこの回で扱う内容の質的な違いを整理します。

**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で扱ったAnsibleによる設定投入（ファイル配置、パッケージインストール）は、投入した時点の状態が固定的です。この種の設定は、Playbookの内容自体が変わらない限り、再実行すれば同じ状態を再現できます。

一方、稼働後にアプリケーション自身が書き込み続けるデータ（レコードの追加等）は、時間とともに増え続けます。このデータが失われた場合、Playbookの再実行では復旧できません。Playbookが記述しているのはあくまで「投入する設定の内容」であり、稼働後に生成された個々のデータの内容までは記述されていないためです。
```

設定の消失（第42回）  
　→ 静的な内容であるため、再実行で同じ状態を再現できる

データの消失（第44回）  
　→ 動的に増え続けた内容であるため、再実行しても復元できない

```

この被害の質の違いが、データの消失を、設定の消失とは別に独立して扱う理由です。

次のセクションでは、この違いを踏まえたうえで、実際にデータの消失を実機で確認します。

---

[↑ 目次に戻る](#-目次)

---


## 5. 実機再現：再生成によるデータ喪失

この回の中心となる検証セクションです。target-node1上にAnsibleで簡易的なデータストアを構築し、レコードを投入したうえで、`replace_triggered_by`による再生成を発生させ、投入したデータが実際に消失することを確認します。

### ■ 検証内容：データストアへのレコード投入

target-node1にAnsibleで`sqlite3`パッケージをインストールし、データベースファイルを作成したうえでレコードを投入します。

* **ファイル名：`playbooks/data_loss_marker.yml`（新規作成）**

```yaml
---
- name: 第44回検証用データストア投入Playbook
  hosts: target-node1
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

**実行コマンド**

```plaintext
ansible-playbook -i ../../docker-lab/inventory.ini data_loss_marker.yml
```

**▼ 実行結果**

```plaintext
PLAY [第44回検証用データストア投入Playbook] *************************************************************************************************************************************************

TASK [sqlite3パッケージをインストール] ******************************************************************************************************************************************************
changed: [target-node1]

TASK [データ格納用ディレクトリを作成] *******************************************************************************************************************************************************
changed: [target-node1]

TASK [テーブルを作成しレコードを投入] *******************************************************************************************************************************************************
changed: [target-node1]

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=3    changed=3    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

配置内容を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "sqlite3 /var/lib/app_data/records.db 'SELECT * FROM records;'"
```

**▼ 実行結果**

```plaintext
1|record-1
2|record-2
3|record-3
```

target-node1に、Ansibleが投じたデータとして、3件のレコードが存在する状態になりました。

### ■ 検証内容：`replace_triggered_by`による再生成の発生

`main.tf`の`docker_container.targets`には、**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)** 終了時点から引き続き`replace_triggered_by = [tls_private_key.generated]`が設定されています。この設定を利用し、`tls_private_key.generated`を意図的にtaintします。

**実行コマンド**

```plaintext
terraform taint tls_private_key.generated
```

**▼ 実行結果**

```plaintext
Resource instance tls_private_key.generated has been marked as tainted.
```

この状態で`terraform plan`を実行し、影響範囲を確認します。

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
      ~ hostname                                    = "9220519475f6" -> (known after apply)
      ~ id                                          = "9220519475f63df96b90d950cbd74da746c3396de12a751b0dec443469cb9e3f" -> (known after apply)
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
              - ip_address                = "172.20.0.2"
              - ip_prefix_length          = 24
              - mac_address               = "e2:ba:3c:06:55:fc"
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

      - upload { # forces replacement
          - content        = <<-EOT
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ9ZflEAp+DdFuvvm/+Y7HhfCtg0n51gm5xN4IfNH9aM control@ubuntu-controller

                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII09fqlBtvwmPmXj1Vm+UsRrNkKykf+ylVtsEkcj6NEz
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
      ~ hostname                                    = "98a37b582162" -> (known after apply)
      ~ id                                          = "98a37b58216216cd8b302b5ce6060b3bcea86d7d5ec71f50a35bc20c0845c2cb" -> (known after apply)
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
              - mac_address               = "92:a7:12:57:57:65"
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

      - upload { # forces replacement
          - content        = <<-EOT
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ9ZflEAp+DdFuvvm/+Y7HhfCtg0n51gm5xN4IfNH9aM control@ubuntu-controller

                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII09fqlBtvwmPmXj1Vm+UsRrNkKykf+ylVtsEkcj6NEz
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

  # docker_container.targets["target-node3"] will be replaced due to changes in replace_triggered_by
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
      ~ hostname                                    = "1e297b6c7838" -> (known after apply)
      ~ id                                          = "1e297b6c7838429d682c3532d51398d9b2064617d8687684b24db2a52e4d4255" -> (known after apply)
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
              - ip_address                = "172.20.0.4"
              - ip_prefix_length          = 24
              - mac_address               = "c6:cf:47:46:f5:e1"
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

      - upload { # forces replacement
          - content        = <<-EOT
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ9ZflEAp+DdFuvvm/+Y7HhfCtg0n51gm5xN4IfNH9aM control@ubuntu-controller

                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII09fqlBtvwmPmXj1Vm+UsRrNkKykf+ylVtsEkcj6NEz
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

  # local_file.ansible_inventory must be replaced
-/+ resource "local_file" "ansible_inventory" {
      ~ content              = <<-EOT
            [target_nodes]
            target-node1 ansible_host=172.20.0.2 ansible_user=ansible
            target-node2 ansible_host=172.20.0.3 ansible_user=ansible
            target-node3 ansible_host=172.20.0.4 ansible_user=ansible
        EOT -> (known after apply) # forces replacement
        # (7 unchanged attributes hidden)
    }

  # local_file.group_vars_target_nodes must be replaced
-/+ resource "local_file" "group_vars_target_nodes" {
      ~ content              = <<-EOT
            nginx_settings:
              worker_connections: 768
              targets:
              - name: target-node1
                ip: 172.20.0.2
              - name: target-node2
                ip: 172.20.0.3
              - name: target-node3
                ip: 172.20.0.4
        EOT -> (known after apply) # forces replacement
        # (7 unchanged attributes hidden)
    }

  # local_file.private_key must be replaced
-/+ resource "local_file" "private_key" {
      ~ content              = (sensitive value) # forces replacement
        # (7 unchanged attributes hidden)
    }

  # tls_private_key.generated is tainted, so must be replaced
-/+ resource "tls_private_key" "generated" {
      ~ id                            = "b82d28946b4151ab66c0c624148fa1678e3da4bc" -> (known after apply)
      ~ private_key_openssh           = (sensitive value)
      ~ private_key_pem               = (sensitive value)
      ~ private_key_pem_pkcs8         = (sensitive value)
      ~ public_key_fingerprint_md5    = "ba:9f:f6:92:0f:db:d1:6c:6c:55:9b:25:0a:fe:ea:53" -> (known after apply)
      ~ public_key_fingerprint_sha256 = "SHA256:SvEkxocpfwLjquK73NEvHDPuOPqi/C0VXYdJAdp/ddw" -> (known after apply)
      ~ public_key_openssh            = <<-EOT
            ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII09fqlBtvwmPmXj1Vm+UsRrNkKykf+ylVtsEkcj6NEz
        EOT -> (known after apply)
      ~ public_key_pem                = <<-EOT
            -----BEGIN PUBLIC KEY-----
            MCowBQYDK2VwAyEAjT1+qUG2/CY+ZePVWb5SxGs2QrKR/7KVW2wSRyPo0TM=
            -----END PUBLIC KEY-----
        EOT -> (known after apply)
        # (3 unchanged attributes hidden)
    }

Plan: 7 to add, 0 to change, 7 to destroy.

（途中省略：Changes to Outputs）
```

`docker_container.targets["target-node1"]`・`["target-node2"]`・`["target-node3"]`のすべてに`will be replaced due to changes in replace_triggered_by`という計画が立てられました。**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** セクション4、**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)** セクション3で確認した通り、`replace_triggered_by`は`for_each`一括生成のため3台に一律で及びます。この計画で`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Planの再掲、yes確認）

local_file.ansible_inventory: Destroying... [id=5be39bf94b8b814c5107e1a0cf2248e68b7e1ff8]
local_file.group_vars_target_nodes: Destroying... [id=c559cb3f53a7cd883fbf3215e55a9bee64510f9f]
local_file.private_key: Destroying... [id=ae0363034c8916fe58cf87a4c3414ae354d2793c]
local_file.group_vars_target_nodes: Destruction complete after 0s
local_file.ansible_inventory: Destruction complete after 0s
local_file.private_key: Destruction complete after 0s
docker_container.targets["target-node2"]: Destroying... [id=98a37b58216216cd8b302b5ce6060b3bcea86d7d5ec71f50a35bc20c0845c2cb]
docker_container.targets["target-node1"]: Destroying... [id=9220519475f63df96b90d950cbd74da746c3396de12a751b0dec443469cb9e3f]
docker_container.targets["target-node3"]: Destroying... [id=1e297b6c7838429d682c3532d51398d9b2064617d8687684b24db2a52e4d4255]
docker_container.targets["target-node3"]: Destruction complete after 1s
docker_container.targets["target-node1"]: Destruction complete after 1s
docker_container.targets["target-node2"]: Destruction complete after 1s
tls_private_key.generated: Destroying... [id=b82d28946b4151ab66c0c624148fa1678e3da4bc]
tls_private_key.generated: Destruction complete after 0s
tls_private_key.generated: Creating...
tls_private_key.generated: Creation complete after 0s [id=5e8bb2b04307c5dcb8c11a464519006f7f02cee3]
local_file.private_key: Creating...
local_file.private_key: Creation complete after 0s [id=fb02f9a5cc39ef2541906fa5905ca99b8e1cdca4]
docker_container.targets["target-node3"]: Creating...
docker_container.targets["target-node2"]: Creating...
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node3"]: Creation complete after 2s [id=40d075660c8e1a2c6608e2105a1cb7ff5ec2923fa7268de933d86672cb1a378a]
docker_container.targets["target-node2"]: Creation complete after 2s [id=459b96c887507d8807f5c724ff5ee08e0cc522084f809c854c50099349f22b11]
docker_container.targets["target-node1"]: Creation complete after 2s [id=3d2eae6f0af6af7c7fcf61df9d5417d60fc665884673c6ac3e5dbf472a0dcfd6]
local_file.group_vars_target_nodes: Creating...
local_file.ansible_inventory: Creating...
local_file.group_vars_target_nodes: Creation complete after 0s [id=c0fbb73f582c7117ef952466f59125185ed5d43e]
local_file.ansible_inventory: Creation complete after 0s [id=733afaba17b50383acf6b02a681a2bf4379feed0]

Apply complete! Resources: 7 added, 0 changed, 7 destroyed.
```

target-node1〜3がすべて新しいコンテナとして再作成されたことを確認したうえで、投入していたデータストアの状態を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "sqlite3 /var/lib/app_data/records.db 'SELECT * FROM records;' 2>&1"
```

**▼ 実行結果**

```plaintext
bash: line 1: sqlite3: command not found
```

`sqlite3`コマンド自体が存在しないため、念のためディレクトリの存在を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "ls -la /var/lib/app_data/ 2>&1"
```

**▼ 実行結果**

```plaintext
ls: cannot access '/var/lib/app_data/': No such file or directory
```

### ■ 結果

再生成前のtarget-node1には、`sqlite3`パッケージ、`/var/lib/app_data/`ディレクトリ、そしてその中に3件のレコード(`record-1`、`record-2`、`record-3`)を持つデータベースファイルが存在していました。

`replace_triggered_by`による再生成後、`sqlite3`コマンド自体が`command not found`となり、`/var/lib/app_data/`ディレクトリも`No such file or directory`という結果になりました。パッケージ、ディレクトリ、データベースファイル、レコードのすべてが失われています。

`terraform apply`自体は、`Apply complete! Resources: 7 added, 0 changed, 7 destroyed`というエラーのない結果で完了しています。コンテナというリソースの再生成としては、この処理は完全に正常です。しかし、その内部でAnsibleが投じたパッケージと、稼働後にアプリケーションが生成し続けたデータは、種類を問わずどちらも、この正常な処理の中で静かに失われています。

次のセクションでは、この結果を踏まえ、Terraform側から見た「正常終了」との対比を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. Terraform側から見た「正常終了」との対比

この現象に対するTerraformの立場を改めて整理します。

**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** で整理した通り、tfstateが記録するのはリソース属性のみであり、コンテナ内部のファイルシステムの状態は観測対象に含まれていません。**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** では、この構造のもとで再生成が発生した際、`terraform apply`がエラーや警告を一切出さずに完了することを確認しました。

セクション5で確認した結果も同じです。target-node1のデータベースファイル、その中の3件のレコード、`sqlite3`パッケージが失われたにもかかわらず、`terraform apply`は`Apply complete! Resources: 7 added, 0 changed, 7 destroyed`というログで正常に完了しています。この消失は、Terraformにとってはtfstate管理範囲外の出来事であり、`terraform apply`が検知する対象にそもそも含まれていません。
```

Terraformの実行結果：Apply complete!（エラーなし）  
　↓  
実際に起きていること：投入したレコード、パッケージの全損  
　→ 両者の間に情報の接続点がない

```

失われたデータの重要性と、Terraformの検知範囲は無関係です。今回消失したのは検証用の3件のレコードでしたが、たとえこれが運用上重要なデータベースの中身であったとしても、Terraformは同じように`Apply complete!`とだけ表示して処理を終えます。tfstateに記録されている属性がすべて意図通りであれば、Terraformにとってその`apply`は成功です。

「エラーが出ないこと」と「問題が起きていないこと」は同義ではありません。この対比が、この回全体を通じて確認してきた内容の結論です。

次のセクションでは、この回で整理した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* Dockerコンテナのファイルシステムはコンテナのライフサイクルに紐づいており、Volumeマウント等で明示的に外部化されていない限り、コンテナ内部で生成されたデータは書き込み可能レイヤーとともにすべて失われることを整理した
* 仮想マシン環境でも、AWS EC2の`DeleteOnTermination`属性、GCP Compute Engineの`autoDelete`属性がいずれもデフォルトで有効であり、インスタンスの終了とともにルートボリュームが削除される点で、コンテナと構造的に共通していることを整理した
* **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で扱った静的な設定の消失は再実行で復元できるが、稼働後にアプリケーション自身が生成し続ける動的なデータの消失は、再実行しても復元できない。この被害の質の違いが、データの消失を独立して扱う理由であることを整理した
* target-node1にAnsibleで`sqlite3`パッケージ、データベースファイル、3件のレコードを投入した状態から、`replace_triggered_by`による再生成を発生させたところ、パッケージ、ディレクトリ、データベースファイル、レコードのすべてが失われることを実機で確認した
* `terraform apply`は`Apply complete! Resources: 7 added, 0 changed, 7 destroyed`というエラーのないログで完了しており、失われたデータの重要性とTerraformの検知範囲は無関係であることを確認した。「エラーが出ないこと」と「問題が起きていないこと」は同義ではない
* この障害への対策（Volumeによるデータの永続化）は **[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** で扱う

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

第44回となる今回は、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で確認した設定の消失を踏まえ、稼働後に生成され続けるデータの消失という、より深刻なケースを扱いました。コンテナ、仮想マシンいずれにおいても、リソースのライフサイクルに紐づいたストレージ領域が破棄されれば、内部のデータは種類を問わず失われる構造を整理したうえで、target-node1に投入したデータベースの消失を実機で再現しました。`terraform apply`自体はエラーなく完了しており、この消失がTerraformの検知範囲外にあることも改めて確認しました。

次回は、リソース単体の変更ではなく、ネットワークなど依存関係にあるリソースの変更が引き金となって、意図していなかった範囲のリソースまで連鎖的に再生成される問題を扱います。

**[次回：第45回：ネットワークや依存リソースの変更に引きずられる連鎖的再生成](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)　｜　[次の記事：【Ansible×Terraform編】第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)**

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
