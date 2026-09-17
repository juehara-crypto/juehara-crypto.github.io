---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第47回：ステートフルなデータ（Volume/DB）を保持しながらの安全な再構築'
description: '内部データをDocker Volumeに分離し、コンテナが再生成されてもAnsibleの投入データを維持する設計を整理する。第42回、第44回、第45回で確認してきたリソース再生成に伴うデータ消失への対策として、Volumeの独立したライフサイクルを実機で確認する。'
pubDate: 2026-09-17
category: 'infra'
tags: ['Ansible', 'Terraform', 'lifecycle', 'Docker Volume', 'データ永続化']
seriesId: 'ansible-terraform-part5'
seriesNo: 47
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-46/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/'
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
2. [`docker_volume`リソースの独立性](#2-docker_volumeリソースの独立性)
3. [コンテナとVolumeの紐付け方](#3-コンテナとvolumeの紐付け方)
4. [再生成時のVolumeの挙動](#4-再生成時のvolumeの挙動)
5. [設計上の注意点](#5-設計上の注意点)
6. [実機再現：Volume構成での再生成](#6-実機再現volume構成での再生成)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

Terraformによるリソースの再生成は、設定だけでなく、稼働後に生成されたデータそのものも消し去ります。

**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** では、`lifecycle`ブロックによる強制再生成によって、Ansibleが投じた設定（ファイル配置、パッケージ導入）が消失することを確認しました。**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** では、静的な設定だけでなく、稼働後にアプリケーション自身が生成し続ける動的なデータも、同様にコンテナの書き込み可能レイヤーとともに失われることを確認しました。**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** では、変更対象として直接指定していないネットワーク等の依存リソースの再生成が、参照構造を通じて接続先のコンテナ群にまで連鎖し、同じデータ消失を引き起こすことを確認しました。

一方、**[第46回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-46/)** では視点が変わり、コード変更ではなく、Ansibleのプロビジョニング実行中に発生する接続切断やプロセス停止という事故を扱いました。この回で確認できたのは、taintedとしてマークされるのはプロビジョナーが定義されている`null_resource.provision`自体であり、プロビジョニングの対象であるtarget-node1〜3（`docker_container.targets`）は、事故の発生前後で一切影響を受けないという結果でした。第46回はこの意味で、データ消失には至らなかった回です。

**[第46回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-46/)** の次回予告で示した通り、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)**、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)**、**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** で確認してきた、コード変更や依存関係を起点とした破棄、再生成そのものは、依然としてAnsible生成データの消失というリスクを伴ったままです。第47回は、この残された課題への解決策として、内部データをDocker Volumeに分離し、コンテナが再生成されてもAnsibleの投入データを生かす設計を扱います。

この回で扱う問いは、「コンテナが作り直されても、データを残すにはどうすればよいか」です。

次のセクションでは、この問いの技術的な土台となる、`docker_volume`リソースの独立性を整理します。

---

[↑ 目次に戻る](#-目次)

---


## 2. `docker_volume`リソースの独立性

この回の解決策の土台となる、Volumeというリソースの性質を整理します。

Volumeはコンテナとは別のリソース（`docker_volume`）として管理されます。この検証環境では、target-node1のデータ永続化用に、以下のようにVolumeを定義しています。

* **ファイル名：`main.tf`（該当箇所）**

```hcl
resource "docker_volume" "target_node1_data" {
  name = "target-node1-data"
}
```

`name`のみを指定する単純な構成です。この`docker_volume`リソースは、`docker_container`側の定義とは別の、独立したTerraformリソースとして存在します。`terraform plan`を実行すると、他のリソースと横並びの、独立した1つの差分として現れます。

**実行コマンド**

```plaintext
terraform plan
```

**▼実行結果（該当箇所抜粋）**

```plaintext
（途中省略：docker_container.targets、docker_network、local_file、null_resource、tls_private_key、module.image_*の計画）

  # docker_volume.target_node1_data will be created
  + resource "docker_volume" "target_node1_data" {
      + driver     = (known after apply)
      + id         = (known after apply)
      + mountpoint = (known after apply)
      + name       = "target-node1-data"
    }

（途中省略：残りのリソースの計画とOutputs）
```

`docker_volume.target_node1_data`は、`docker_container`の定義に含まれる形ではなく、`main.tf`上の別々のブロックとして書かれている通り、`terraform plan`上でも独立した1つの`will be created`として計画されています。`terraform apply`を実行すると、実際にも単独で作成されます。

**実行コマンド**

```plaintext
terraform apply
```

**▼実行結果（該当箇所抜粋）**

```plaintext
（途中省略：tls_private_key.generated、module.image_*、docker_network.app_net、docker_network.lab_netの作成ログ）

docker_volume.target_node1_data: Creating...
local_file.private_key: Creating...
local_file.private_key: Creation complete after 0s [id=9539d500d7464ecfc44a975b6179090a1ed05339]
docker_volume.target_node1_data: Creation complete after 0s [id=target-node1-data]

（途中省略：null_resource.fix_permission、docker_container.targets、local_file.ansible_inventory、local_file.group_vars_target_nodes、null_resource.provisionの作成ログ）
```

`docker_volume.target_node1_data`の作成は、`local_file.private_key`の作成と並行して進んでおり、`id=target-node1-data`として、他のリソースとは独立したタイミングでVolumeが作成されたことが確認できます。
```

【docker_containerとdocker_volumeの関係】  
docker_container.targets（コンテナ）  
　└─ 独自のリソースとして管理される

docker_volume.target_node1_data（Volume）  
　└─ コンテナとは別の、独立したリソースとして管理される

両者は「コンテナがVolumeを参照する」という一方向の関係にあり、  
Volume側からコンテナを参照する構造にはなっていない

```

`docker_container`と`docker_volume`は、Terraform上ではあくまで別々のリソースであり、片方の定義がもう片方の定義に含まれるような構造にはなっていません。次のセクションでは、この2つのリソースを実際にどう紐付けるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. コンテナとVolumeの紐付け方

具体的な接続方法を示すセクションです。

`docker_container`の`volumes`ブロックで`volume_name`を指定してマウントする構成を示します。

* **ファイル名：`main.tf`（該当箇所）**

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
  dynamic "volumes" {
    for_each = local.target_node_volumes[each.key]
    content {
      volume_name    = volumes.value
      container_path = "/var/lib/app_data"
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

target-node1〜3は`for_each`で一括生成されているため、**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** の`networks_advanced`と同じ形で、`target_node_volumes`というマップをノードごとに用意し、`dynamic "volumes"`ブロックでループさせています。

* **ファイル名：`main.tf`（該当箇所）**

```hcl
locals {
  target_node_volumes = {
    "target-node1" = [docker_volume.target_node1_data.name]
    "target-node2" = []
    "target-node3" = []
  }
}
```

target-node1のみ`docker_volume.target_node1_data.name`を含むリストを持ち、target-node2・target-node3は空のリストです。`dynamic`ブロックは空のリストに対しては何も生成しないため、target-node2・target-node3には`volumes`ブロック自体が生成されません。

この状態で`terraform apply`を実行すると、target-node1のみVolumeがマウントされた状態でコンテナが作成されます。

**実行コマンド**

```plaintext
terraform apply
```

**▼実行結果（該当箇所抜粋）**

```plaintext
（途中省略：tls_private_key.generated、module.image_*、docker_network.app_net、docker_network.lab_net、docker_volume.target_node1_data、local_file.private_key、null_resource.fix_permissionの作成ログ）

docker_container.targets["target-node3"]: Creating...
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node2"]: Creating...
docker_container.targets["target-node2"]: Creation complete after 3s [id=83b103c227587b167172f743fcc1820087bd98876e442516ee29663671721c5a]
docker_container.targets["target-node1"]: Creation complete after 3s [id=232a566f52c671bf3bc9135e0573e3c1921b1640d7d6856e4a2ec2764ff2fa18]
docker_container.targets["target-node3"]: Creation complete after 3s [id=f8af52a434e739560b2d4c6af5c9b795cb77c6d945448db2261a168a9c435e29]

（途中省略：local_file.ansible_inventory、local_file.group_vars_target_nodes、null_resource.provisionの作成ログ）
```

target-node1〜3すべて`Creation complete`となりました。実際にVolumeがマウントされているのはtarget-node1のみであることを、`docker inspect`で確認します。

**実行コマンド**

```plaintext
docker inspect target-node1 --format '{{json .Mounts}}'
docker inspect target-node2 --format '{{json .Mounts}}'
docker inspect target-node3 --format '{{json .Mounts}}'
```

**▼実行結果**

```plaintext
[{"Type":"volume","Name":"target-node1-data","Source":"/var/lib/docker/volumes/target-node1-data/_data","Destination":"/var/lib/app_data","Driver":"local","Mode":"rw","RW":true,"Propagation":""}]
[]
[]
```

target-node1には`target-node1-data`というVolumeが`/var/lib/app_data`にマウントされており、target-node2・target-node3にはマウント情報が存在しません（空の配列）。

```
【Volume未使用（第44回の構成）】
コンテナの書き込み可能レイヤー
　└─ すべてのデータがここに存在 → コンテナと運命を共にする

【Volume使用（この回の構成、target-node1）】
コンテナの書き込み可能レイヤー
　└─ 一時的なデータのみ → コンテナと運命を共にする
Volume（docker_volume.target_node1_data）
　└─ /var/lib/app_data配下のデータ → コンテナとは別のライフサイクル
```

コンテナの書き込み可能レイヤー（**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** で扱った、消える対象）とVolumeが別のライフサイクルを持つことが、この対比から整理できます。次のセクションでは、実際にコンテナが再生成された際、このVolumeがどう振る舞うかを確認します。

---

[↑ 目次に戻る](#-目次)

---


## 4. 再生成時のVolumeの挙動

コンテナが再生成された際、Volumeがどう振る舞うかを整理します。

セクション2で確認した通り、`docker_volume`はコンテナとは独立したリソースとして管理されています。この独立性は、コンテナが再生成される場面において、具体的な意味を持ちます。

Dockerの名前付きVolumeは、それをマウントしているコンテナが破棄されても、Volume自体は削除されません。コンテナとVolumeは、Docker上でも別々の管理対象であり、コンテナの削除操作がVolumeにまで及ぶことはありません（Volumeを明示的に削除するには、`docker volume rm`のような別の操作が必要です）。

この性質をもとに整理すると、Volumeを使った構成での再生成は、以下のような流れをたどります。
```

① コンテナが破棄される（Volumeは影響を受けない）  
　↓  
② 新しいコンテナが作成される  
　↓  
③ 新しいコンテナが既存のVolumeを再マウントする  
　↓  
④ 新しいコンテナから、以前と同じデータにアクセスできる

```

セクション3で確認した`main.tf`の構成では、target-node1が再生成された場合も、`docker_container.targets["target-node1"]`の`volumes`ブロックは変わらず`docker_volume.target_node1_data.name`を参照し続けます。コンテナ側の`id`が変わっても、参照先のVolume自体（`id=target-node1-data`）は同一のまま存在し続けるため、新しいコンテナは同じVolumeを再マウントすることになります。
```

【Volume未使用（第44回の構成）】  
コンテナが破棄される → 書き込み可能レイヤーごと消滅 → データは復元不可能

【Volume使用（この回の構成）】  
コンテナが破棄される → Volumeは影響を受けず存続 → 新コンテナが再マウント → データは維持される

```

この構造が実際にそのまま機能するかどうかは、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** ・**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** と同様の手順でデータを投入したうえで、コンテナの再生成を実際に発生させて確認します。

---

[↑ 目次に戻る](#-目次)

---


## 5. 設計上の注意点

Volumeを使えば万事解決というわけではないことを整理するセクションです。

Volumeを使えば全てのデータが自動的に保護されるわけではありません。セクション3で確認した通り、`docker_container.targets`の`volumes`ブロックは`container_path = "/var/lib/app_data"`という特定のパスのみを対象にしています。このパス配下に置かれたデータだけがVolumeによって保護され、それ以外のパスに書き込まれたデータは、これまで通りコンテナの書き込み可能レイヤー上に存在し、コンテナの再生成で失われます。

**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** で確認した通り、Ansibleが投じるものには、設定ファイルのように内容が固定的なものと、稼働後に増え続けるデータの両方があります。Volume化の対象を検討する際は、この両者を区別し、どちらをVolume側に置くかという設計判断が必要になります。

```

【役割分担の考え方】  
アプリケーションの設定ファイル  
　└─ Ansible Playbookによる冪等な投入で管理する  
　　　（Playbookの再実行で同じ状態を再現できるため、Volume化の必要性は低い）

稼働後に生成され続けるデータ（データベースのレコード等）  
　└─ Volumeに配置し、コンテナのライフサイクルから切り離す  
　　　（再実行では復元できないデータであるため、Volume化の対象になる）

```

すべてを一律にVolumeへ配置するのではなく、データの性質に応じて配置先を切り分けるという考え方が、この設計の基本になります。

また、Volumeに配置していないディレクトリへの変更は、これまで通りコンテナの再生成で失われます。この点は、「Volumeを導入した」という事実だけでは変わりません。保護されるのは、あくまでVolumeのマウントパスとして明示的に指定した範囲に限られます。

次のセクションでは、この構成が実際にコンテナの再生成に対してどう機能するかを、実機で確認します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 実機再現：Volume構成での再生成

この回の総仕上げとなる検証セクションです。target-node1に投入したデータが、コンテナの再生成後も引き継がれることを実機で確認します。

### ■ 検証内容：データストアへのレコード投入

target-node1のVolumeマウントパス（`/var/lib/app_data`）配下に、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** と同様の簡易データストアを構築します。

* **ファイル名：`../ansible/playbooks/data_persistence_marker_part5_47.yml`（新規作成）**

```yaml
---
- name: 第47回検証用データストア投入Playbook
  hosts: target-node1
  gather_facts: false
  become: true

  tasks:
    - name: sqlite3パッケージをインストール
      ansible.builtin.apt:
        name: sqlite3
        state: present
        update_cache: true

    - name: テーブルを作成しレコードを投入
      ansible.builtin.command:
        cmd: >
          sqlite3 /var/lib/app_data/records.db
          "CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, note TEXT);
           INSERT INTO records (note) VALUES ('record-1'), ('record-2'), ('record-3');"
```

**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** のPlaybookとは異なり、データ格納用ディレクトリを作成するタスクは含まれていません。`/var/lib/app_data`はVolumeのマウントポイントとしてDockerが既に用意しているため、ディレクトリ自体は既に存在しています。

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini ../ansible/playbooks/data_persistence_marker_part5_47.yml
```

**▼実行結果**

```plaintext
PLAY [第47回検証用データストア投入Playbook] *************************************************************************************************************************************************

TASK [sqlite3パッケージをインストール] ******************************************************************************************************************************************************
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python
interpreter could change the meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
changed: [target-node1]

TASK [テーブルを作成しレコードを投入] *******************************************************************************************************************************************************
changed: [target-node1]

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

配置内容を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "sqlite3 /var/lib/app_data/records.db 'SELECT * FROM records;'"
```

**▼実行結果**

```plaintext
1|record-1
2|record-2
3|record-3
```

target-node1に、Ansibleが投じたデータとして3件のレコードが存在する状態になりました。

### ■ 検証内容：`replace_triggered_by`による再生成の発生

`docker_container.targets`には、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** から引き続き`replace_triggered_by = [tls_private_key.generated]`が設定されています。**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** と同様、この設定を利用し、`tls_private_key.generated`を意図的にtaintします。

**実行コマンド**

```plaintext
terraform taint tls_private_key.generated
```

**▼実行結果**

```plaintext
Resource instance tls_private_key.generated has been marked as tainted.
```

この状態で`terraform plan`を実行し、影響範囲を確認します。

**実行コマンド**

```plaintext
terraform plan
```

**▼実行結果**

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
      ~ hostname                                    = "232a566f52c6" -> (known after apply)
      ~ id                                          = "232a566f52c671bf3bc9135e0573e3c1921b1640d7d6856e4a2ec2764ff2fa18" -> (known after apply)
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
              - gateway                   = "172.19.0.1"
              - global_ipv6_prefix_length = 0
              - ip_address                = "172.19.0.4"
              - ip_prefix_length          = 16
              - mac_address               = "c2:75:fb:d5:cc:61"
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

                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHrk1ZfVLQGj5O9C0hMo8n1vAKkxvNf6KEaxA7nhp+JI
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

      - volumes {
          - container_path = "/var/lib/app_data" -> null
          - read_only      = false -> null
          - volume_name    = "target-node1-data" -> null
            # (2 unchanged attributes hidden)
        }
      + volumes {
          + container_path = "/var/lib/app_data"
          + volume_name    = "target-node1-data"
            # (2 unchanged attributes hidden)
        }

        # (3 unchanged blocks hidden)
    }

  # docker_container.targets["target-node2"] will be replaced due to changes in replace_triggered_by
（途中省略：target-node1と同様の属性差分。ネットワーク情報のみtarget-node2固有の値：ip_address = "172.19.0.3"、mac_address = "ea:d0:c7:3c:e4:f0"。volumesブロックの差分は含まれない）

  # docker_container.targets["target-node3"] will be replaced due to changes in replace_triggered_by
（途中省略：target-node1と同様の属性差分。ネットワーク情報のみtarget-node3固有の値：ip_address = "172.19.0.2"、mac_address = "2e:00:b2:90:b3:3a"。volumesブロックの差分は含まれない）

  # local_file.ansible_inventory must be replaced
（途中省略：内部IPアドレス変更に伴うcontent差分とハッシュ値の再計算）

  # local_file.group_vars_target_nodes must be replaced
（途中省略：内部IPアドレス変更に伴うcontent差分とハッシュ値の再計算）

  # local_file.private_key must be replaced
（途中省略：tls_private_key.generated再生成に伴う秘密鍵内容の差分）

  # null_resource.provision must be replaced
-/+ resource "null_resource" "provision" {
      ~ id       = "4522143398669760983" -> (known after apply)
      ~ triggers = { # forces replacement
          ~ "playbook_hash" = "751f66d23dc0f2100be2ce26ec6dde8ca6aaeb72560f13ba17fe270fb65ba88b" -> "841685530637a067d42e2ac56161bd008f316c59baeb3d4d2c6a509a2203fcc0"
        }
    }

  # tls_private_key.generated is tainted, so must be replaced
（途中省略：秘密鍵、公開鍵フィンガープリント等の属性差分）

Plan: 8 to add, 0 to change, 8 to destroy.

（途中省略：Changes to Outputs）
```

`docker_container.targets["target-node1"]`・`["target-node2"]`・`["target-node3"]`のすべてに`will be replaced due to changes in replace_triggered_by`という計画が立てられました。target-node1の差分には`volumes`ブロックの`-`（削除）と`+`（追加）が含まれていますが、これはコンテナ全体が破棄、再作成される際の表示であり、参照先の`docker_volume.target_node1_data`自体はこのplan結果に一切含まれていません。Volume自体は変更対象になっていないことが、ここでも確認できます。

`Plan: 8 to add, 0 to change, 8 to destroy`です。この計画で`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼実行結果**

```plaintext
（途中省略：Planの再掲、yes確認）

local_file.group_vars_target_nodes: Destroying... [id=72ba4a4e23cf4bcad6180ed35a55ac3bce0bc1d3]
local_file.group_vars_target_nodes: Destruction complete after 0s
null_resource.provision: Destroying... [id=4522143398669760983]
local_file.private_key: Destroying... [id=9539d500d7464ecfc44a975b6179090a1ed05339]
null_resource.provision: Destruction complete after 0s
local_file.private_key: Destruction complete after 0s
local_file.ansible_inventory: Destroying... [id=0114bd8731baa2c029e7fc7be9c30f188b3488ae]
local_file.ansible_inventory: Destruction complete after 0s
docker_container.targets["target-node2"]: Destroying... [id=83b103c227587b167172f743fcc1820087bd98876e442516ee29663671721c5a]
docker_container.targets["target-node1"]: Destroying... [id=232a566f52c671bf3bc9135e0573e3c1921b1640d7d6856e4a2ec2764ff2fa18]
docker_container.targets["target-node3"]: Destroying... [id=f8af52a434e739560b2d4c6af5c9b795cb77c6d945448db2261a168a9c435e29]
docker_container.targets["target-node1"]: Destruction complete after 1s
docker_container.targets["target-node3"]: Destruction complete after 1s
docker_container.targets["target-node2"]: Destruction complete after 1s
tls_private_key.generated: Destroying... [id=d27e5788245bbf938c7f14860d9e12bbf17ca5b8]
tls_private_key.generated: Destruction complete after 0s
tls_private_key.generated: Creating...
tls_private_key.generated: Creation complete after 0s [id=75cc6634ff7af80f73c201c175cb509facca1fec]
local_file.private_key: Creating...
local_file.private_key: Creation complete after 0s [id=64b4c7c7181781ce8a4637f59386cf42b8377cc2]
docker_container.targets["target-node3"]: Creating...
docker_container.targets["target-node2"]: Creating...
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node1"]: Creation complete after 3s [id=e25a38aa8263389326002266d328f42ebd2ad16786826c016ff6738c00558b15]
docker_container.targets["target-node3"]: Creation complete after 3s [id=3e8342923995c18412224f09cb58eebb73f74934e10a5f6cbc4726abdcd10f36]
docker_container.targets["target-node2"]: Creation complete after 4s [id=111e0a2b40bc913dc04b0702a22dae4e23a93290bd32355aab835b6d3e720a6d]
local_file.ansible_inventory: Creating...
local_file.group_vars_target_nodes: Creating...
local_file.ansible_inventory: Creation complete after 0s [id=0c76eb5d515398d39ded8f3d335bf0216077007d]
local_file.group_vars_target_nodes: Creation complete after 0s [id=d93eda126138e518c10cb611268e582b0dbb23ca]
null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ansible-playbook -i inventory.ini site.yml"]

null_resource.provision (local-exec): PLAY [接続確認用Playbook] ******************************************************

null_resource.provision (local-exec): TASK [common : 疎通確認（common role・第35回更新）] ****************************
null_resource.provision (local-exec): [WARNING]: Platform linux on host target-node3 is using the discovered Python
null_resource.provision (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.provision (local-exec): interpreter could change the meaning of that path. See
null_resource.provision (local-exec): https://docs.ansible.com/ansible-
null_resource.provision (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.provision (local-exec): [WARNING]: Platform linux on host target-node2 is using the discovered Python
null_resource.provision (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.provision (local-exec): interpreter could change the meaning of that path. See
null_resource.provision (local-exec): https://docs.ansible.com/ansible-
null_resource.provision (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.provision (local-exec): [WARNING]: Platform linux on host target-node1 is using the discovered Python
null_resource.provision (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.provision (local-exec): interpreter could change the meaning of that path. See
null_resource.provision (local-exec): https://docs.ansible.com/ansible-
null_resource.provision (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.provision (local-exec): ok: [target-node3]
null_resource.provision (local-exec): ok: [target-node2]
null_resource.provision (local-exec): ok: [target-node1]

null_resource.provision (local-exec): TASK [common_setup : apt-cacher-ng経由でaptパッケージを取得するようプロキシを設定] ***
null_resource.provision (local-exec): changed: [target-node3]
null_resource.provision (local-exec): changed: [target-node1]
null_resource.provision (local-exec): changed: [target-node2]

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node2               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node3               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

null_resource.provision: Creation complete after 5s [id=2497859378414229610]

Apply complete! Resources: 8 added, 0 changed, 8 destroyed.
```

target-node1〜3がすべて新しいコンテナとして再作成されたことを確認したうえで、投入していたデータストアの状態を確認します。

### ■ 検証内容：再生成後のデータ確認

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "sqlite3 /var/lib/app_data/records.db 'SELECT * FROM records;' 2>&1"
```

**▼実行結果**

```plaintext
bash: line 1: sqlite3: command not found
```

`sqlite3`コマンド自体が`command not found`となりました。**[セクション5](#5-設計上の注意点)** で整理した通り、`sqlite3`パッケージはVolumeのマウントパス（`/var/lib/app_data`）の外にインストールされたものであり、コンテナの書き込み可能レイヤーに属します。コンテナが再生成された以上、このパッケージ自体が消えるのは想定通りの挙動です。確認すべきは、Volume化した対象であるデータベースファイル自体が残っているかどうかです。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "ls -la /var/lib/app_data/ 2>&1"
```

**▼実行結果**

```plaintext
total 16
drwxr-xr-x 2 root root 4096 Sep 17 07:07 .
drwxr-xr-x 1 root root 4096 Sep 17 07:15 ..
-rw-r--r-- 1 root root 8192 Sep 17 07:07 records.db
```

`records.db`ファイルが存在しています。タイムスタンプ（`Sep 17 07:07`）も、レコードを投入した時点のままであり、コンテナ再生成後に新規生成されたものではないことが分かります。中身を確認するため、`sqlite3`コマンドを改めてインストールします。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "apt-get install -y sqlite3 2>&1 | tail -5"
```

**▼実行結果**

```plaintext
Reading package lists...
Building dependency tree...
Reading state information...
E: Unable to locate package sqlite3
```

パッケージリストが未更新のため失敗しました。これも、コンテナの再生成によってaptのパッケージリストキャッシュ自体が失われた（＝Volume化の対象外だった）ことを示しています。`apt-get update`を先に実行したうえで、改めてインストールします。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "apt-get update 2>&1 | tail -10 && apt-get install -y sqlite3 2>&1 | tail -5"
```

**▼実行結果**

```plaintext
（途中省略：apt-get updateによるパッケージリスト取得ログ冒頭部分）
Fetched 48.2 MB in 4s (11.7 MB/s)
Reading package lists...
Selecting previously unselected package sqlite3.
(Reading database ... 10762 files and directories currently installed.)
Preparing to unpack .../sqlite3_3.37.2-2ubuntu0.8_amd64.deb ...
Unpacking sqlite3 (3.37.2-2ubuntu0.8) ...
Setting up sqlite3 (3.37.2-2ubuntu0.8) ...
```

インストールが完了したので、改めてデータの中身を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "sqlite3 /var/lib/app_data/records.db 'SELECT * FROM records;'"
```

**▼実行結果**

```plaintext
1|record-1
2|record-2
3|record-3
```

### ■ 結果

`record-1`・`record-2`・`record-3`の3件のレコードすべてが、コンテナの再生成後も失われていないことを確認できました。**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** ・**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** では、同様の`replace_triggered_by`による再生成によってこの種のデータがすべて失われることを確認しましたが、今回はVolumeにマウントした`/var/lib/app_data`配下のデータのみが、コンテナのライフサイクルを超えて引き継がれました。

一方で、`sqlite3`パッケージ自体はVolume化していない範囲にあったため、コンテナの再生成によって失われました。この結果は、**[セクション5](#5-設計上の注意点)** で整理した「Volumeによる保護は、明示的にマウントした範囲に限られる」という原則を、そのまま裏付けるものになりました。

---

[↑ 目次に戻る](#-目次)

---


## 7. まとめ

この回で整理した内容を確認します。

* Volumeはコンテナとは別のリソース（`docker_volume`）として管理されており、コンテナ側の属性変更によってコンテナが再生成されても、Volumeリソース自体は変更対象にならないことを実機で確認した
* `docker_container`の`volumes`ブロックで`volume_name`を指定してマウントする構成により、コンテナの書き込み可能レイヤーとVolumeが別のライフサイクルを持つことを整理した
* target-node1にVolumeをマウントした状態でAnsibleによりデータストア（`sqlite3`パッケージ、`records.db`、3件のレコード）を投入したうえで、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** ・**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** と同じ`replace_triggered_by`による再生成を発生させ、Volumeにマウントした`/var/lib/app_data`配下のデータ（`records.db`とその中身）が再生成後も失われないことを実機で確認した
* 一方で、`sqlite3`パッケージ自体はVolume化していない範囲（コンテナの書き込み可能レイヤー）にあったため、コンテナの再生成によって失われることも実機で確認した。Volumeによる保護は自動的な万能策ではなく、明示的にマウントした範囲に限られることが、この対比から裏付けられた
* **[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** ・**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** で確認した「消える」結果と、今回の「Volume化した範囲は残る」という結果を対比させることで、コンテナ再生成に対するデータ保護の実現方法を実機で示すことができた

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

第47回となる今回は、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** ・**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** で確認してきたリソース再生成に伴うデータ消失への対策として、Docker Volumeによるデータの外部化を扱いました。Volumeがコンテナとは独立したライフサイクルを持つリソースであることを整理したうえで、実際にコンテナを再生成させ、Volumeにマウントした範囲のデータのみが引き継がれることを実機で確認しました。

一方で、この回で扱ったのはあくまでコンテナ再生成に対するデータの生存に焦点を絞った内容です。「実行時にAnsibleで設定を投入する」という運用そのものに、なお残る課題があります。

次回は、視点を変え、そもそも実行時にAnsibleで設定変更を加える運用自体を見直し、ビルド時にAnsibleを組み込んでコンテナイメージを焼き込むイミュータブルな運用への転換を扱います。

**[次回：第48回：イミュータブルインフラストラクチャにおけるAnsibleの限定的役割](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第46回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-46/)　｜　[次の記事：【Ansible×Terraform編】第48回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/)**

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