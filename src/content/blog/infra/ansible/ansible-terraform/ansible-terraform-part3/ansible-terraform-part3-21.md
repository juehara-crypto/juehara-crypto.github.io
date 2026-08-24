---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第21回：統合実行時におけるネストされたエラーログの解析手法'
description: 'Terraformのlocal-exec経由で実行されたAnsibleのエラーが、terraform applyの単一のエラーメッセージに集約される構造を整理する。ANSIBLE_LOG_PATHによるログの分離取得と、両ツールのログを時系列で突き合わせて原因を特定する手法を扱う。'
pubDate: 2026-08-24
category: 'infra'
tags: ['Ansible', 'Terraform', 'local-exec', 'ログ解析', 'デバッグ']
seriesId: 'ansible-terraform-part3'
seriesNo: 21
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-20/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/'
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
2. [local-exec経由でAnsibleを実行した場合のログ出力構造](#2-local-exec経由でansibleを実行した場合のログ出力構造)
3. [Ansible側のエラー情報が埋没する仕組み](#3-ansible側のエラー情報が埋没する仕組み)
4. [ANSIBLE_LOG_PATHによるログの分離取得](#4-ansible_log_pathによるログの分離取得)
5. [Terraform側とAnsible側のログを突き合わせる手順](#5-terraform側とansible側のログを突き合わせる手順)
6. [ログ遮蔽問題と実行失敗問題の切り分け](#6-ログ遮蔽問題と実行失敗問題の切り分け)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「`terraform apply`のエラーメッセージを読めば、何が原因かわかるはずだ」と考えて実行結果を追いかけたことはないでしょうか。

第2部（第11〜20回）では、TerraformとAnsibleそれぞれの管理範囲の違いによって生じる構造的な問題を扱いました。手動変更によるドリフト、初期化処理によるOS設定の上書き、リソースの強制再生成、Playbookの冪等性、tfstateの整合性、パッケージアップデートによる非互換、IPアドレスの変動、機密情報の役割分担、OSのメジャーバージョンアップ。これらはいずれも、問題がどう起きるかという構造を理解した上で、それを未然に防ぐ、あるいは安全に受け止めるための設計を整理する回でした。

第3部（第21〜30回）では、この視点が変わります。第2部までが「設計、運用でどう防ぐか」を扱っていたのに対し、第3部は「起きてしまった問題を、どう特定するか」という、障害発生時の原因特定とデバッグに焦点を移します。

その起点となる第21回で扱うのは、TerraformとAnsibleを連携実行した際に、エラーログそのものがどう変質するかという問題です。`local-exec`経由でAnsibleを実行する構成では、Terraformはlocal-execで起動したプロセスの終了コードを見ているにすぎません。Ansible内部のどのタスクのどのモジュールが失敗したかという情報は、Terraformのエラーメッセージにそのまま反映されるとは限りません。

この回で扱う問いは、「Terraformのエラー表示と、Ansibleの実際の失敗箇所は、なぜ一致しないのか」です。

次のセクションでは、この問いの前提となる、`local-exec`経由でAnsibleを実行した場合のログ出力構造そのものを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. local-exec経由でAnsibleを実行した場合のログ出力構造

この回の前提となる、`local-exec`の挙動を整理します。

Terraformの`local-exec`プロビジョナーは、起動したプロセスの標準出力、標準エラーをそのままTerraformの実行ログに転送して表示します。プロセスが正常終了している間は、Ansibleの出力がそのままTerraformのログに流れます。問題が起きるのは、プロセスが異常終了した場合です。この場合、`local-exec`はコマンドの終了コードを検知し、`Error: local-exec provisioner error`というエラーとして`terraform apply`自体を失敗させます。

正常時、異常時それぞれのTerraform出力を確認します。

### ■ 検証内容（1）：local-exec経由でAnsibleが正常終了した場合のログ出力

`null_resource.provision`の`local-exec`から、正常に完了するPlaybookを実行します。

* **ファイル名：**`playbooks/test_nested_normal.yml`

```yaml
---
- name: local-execログ構造デモ（正常系）
  hosts: target-node1
  become: true
  gather_facts: false
  tasks:
    - name: 検証用ディレクトリを作成する
      ansible.builtin.file:
        path: /etc/myapp_demo
        state: directory

    - name: 検証用設定ファイルを配置する
      ansible.builtin.copy:
        content: "server { listen 8080; }"
        dest: /etc/myapp_demo/demo.conf
```

* **ファイル名：**`main.tf`（該当箇所）

```hcl
resource "null_resource" "provision" {
  depends_on = [local_file.ansible_inventory]
  provisioner "local-exec" {
    command = "ANSIBLE_SSH_RETRIES=0 ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_normal.yml"
  }
}
```

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
(ansible-env) control@ubuntu-controller:~/iac/docker-lab$ terraform apply
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node2"]: Refreshing state... [id=a33463336b78be7e1b09cfef85e2b18e4cbdcdb4d7f43087e344e8fa6cb62743]
docker_container.targets["target-node1"]: Refreshing state... [id=627d7a6a9fcda8789a23e0da05bf28b2a4106f976b542562e3caa9d873e5a5e8]
docker_container.targets["target-node3"]: Refreshing state... [id=acac4b63e617b41bcb7b9f7126a58bd49c20a9e8fa4d95bf9118c088b5306fcd]
local_file.ansible_inventory: Refreshing state... [id=8d3ed4ce0d69a595289b62511d2fccc77a3907ec]
null_resource.provision: Refreshing state... [id=5876942731684570095]

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # null_resource.provision is tainted, so must be replaced
-/+ resource "null_resource" "provision" {
      ~ id = "5876942731684570095" -> (known after apply)
    }

Plan: 1 to add, 0 to change, 1 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.provision: Destroying... [id=5876942731684570095]
null_resource.provision: Destruction complete after 0s
null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ANSIBLE_SSH_RETRIES=0 ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_normal.yml"]

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

null_resource.provision: Creation complete after 5s [id=212872119496008420]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.20.0.4"
  "target-node2" = "172.20.0.2"
  "target-node3" = "172.20.0.3"
}
```

`ansible-playbook`の出力がそのままTerraformのログに流れ、`Apply complete!`で完了しています。

### ■ 検証内容（2）：local-exec経由でAnsibleが異常終了した場合のログ出力

続いて、途中のタスクが失敗するPlaybookを実行します。`main.tf`の`command`を、以下のPlaybookを実行する内容に変更した上で、同様に`terraform apply`を実行します。

* **ファイル名：**`playbooks/test_nested_error.yml`

```yaml
---
- name: local-execログ構造デモ（異常系）
  hosts: target-node1
  become: true
  gather_facts: false
  tasks:
    - name: 検証用ディレクトリを作成する
      ansible.builtin.file:
        path: /etc/myapp_demo
        state: directory

    - name: 存在しないディレクトリに設定ファイルを配置する（意図的に失敗させる）
      ansible.builtin.copy:
        content: "server { listen 8080; }"
        dest: /etc/myapp_nonexistent_dir/demo.conf
```

* **ファイル名：**`main.tf`（該当箇所）

```hcl
resource "null_resource" "provision" {
  depends_on = [local_file.ansible_inventory]
  provisioner "local-exec" {
    command = "ANSIBLE_SSH_RETRIES=0 ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_error.yml"
  }
}
```

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
(ansible-env) control@ubuntu-controller:~/iac/docker-lab$ terraform apply
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node3"]: Refreshing state... [id=acac4b63e617b41bcb7b9f7126a58bd49c20a9e8fa4d95bf9118c088b5306fcd]
docker_container.targets["target-node2"]: Refreshing state... [id=a33463336b78be7e1b09cfef85e2b18e4cbdcdb4d7f43087e344e8fa6cb62743]
docker_container.targets["target-node1"]: Refreshing state... [id=627d7a6a9fcda8789a23e0da05bf28b2a4106f976b542562e3caa9d873e5a5e8]
local_file.ansible_inventory: Refreshing state... [id=8d3ed4ce0d69a595289b62511d2fccc77a3907ec]
null_resource.provision: Refreshing state... [id=6891917572170158881]

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # null_resource.provision is tainted, so must be replaced
-/+ resource "null_resource" "provision" {
      ~ id = "6891917572170158881" -> (known after apply)
    }

Plan: 1 to add, 0 to change, 1 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.provision: Destroying... [id=6891917572170158881]
null_resource.provision: Destruction complete after 0s
null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ANSIBLE_SSH_RETRIES=0 ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_error.yml"]

null_resource.provision (local-exec): PLAY [local-execログ構造デモ（異常系）] ****************************************

null_resource.provision (local-exec): TASK [検証用ディレクトリを作成する] ********************************************
null_resource.provision (local-exec): [WARNING]: Platform linux on host target-node1 is using the discovered Python
null_resource.provision (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.provision (local-exec): interpreter could change the meaning of that path. See
null_resource.provision (local-exec): https://docs.ansible.com/ansible-
null_resource.provision (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.provision (local-exec): ok: [target-node1]

null_resource.provision (local-exec): TASK [存在しないディレクトリに設定ファイルを配置する（意図的に失敗させる）] ****
null_resource.provision (local-exec): fatal: [target-node1]: FAILED! => {"changed": false, "checksum": "e184461f4646921eabc5a2a0a90a001760003484", "msg": "Destination directory /etc/myapp_nonexistent_dir does not exist"}

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=1    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0

╷
│ Error: local-exec provisioner error
│
│   with null_resource.provision,
│   on main.tf line 101, in resource "null_resource" "provision":
│  101:   provisioner "local-exec" {
│
│ Error running command 'ANSIBLE_SSH_RETRIES=0 ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_error.yml': exit status 2. Output:
│ PLAY [local-execログ構造デモ（異常系）] ****************************************
│
│ TASK [検証用ディレクトリを作成する] ********************************************
│ ok: [target-node1]
│
│ TASK [存在しないディレクトリに設定ファイルを配置する（意図的に失敗させる）] ****
│ fatal: [target-node1]: FAILED! => {"changed": false, "checksum": "e184461f4646921eabc5a2a0a90a001760003484", "msg": "Destination directory /etc/myapp_nonexistent_dir does not exist"}
│
│ PLAY RECAP *********************************************************************
│ target-node1               : ok=1    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
│
│
╵
```

### ■ 結果

正常時と異常時で、出力の構造が明確に異なります。

正常時は、`ansible-playbook`の出力（`PLAY`から`PLAY RECAP`まで）がそのままTerraformのログに流れ、その後`Apply complete!`で完了します。

異常時は、同じく`PLAY`から`PLAY RECAP`までの出力が一度流れた後、さらに`Error: local-exec provisioner error`というブロックが追加されます。このブロックの中には、`Error running command '...': exit status 2. Output:`という一文に続けて、`ansible-playbook`の標準出力が`Output:`の見出しの下にそのまま再掲されています。

この結果から分かるのは、`local-exec`は失敗したコマンドの出力内容を握りつぶしているわけではないという点です。異常時に消えるのは「Ansibleの出力がそのまま流れる」という正常時の見た目であり、代わりに同じ内容がエラーブロックの中に格納された状態に置き換わります。この、異常時に発生する「同じAnsible出力が2箇所に存在する」という状態が、次のセクションで扱う視認性の問題につながります。

---

[↑ 目次に戻る](#-目次)

---

## 3. Ansible側のエラー情報が埋没する仕組み

前セクションで確認した通り、`local-exec`は失敗したコマンドの出力を握りつぶしているわけではありません。異常終了時、Ansibleの実行結果（`PLAY`から`PLAY RECAP`まで）は、通常の実行ログとして一度流れたのち、`Error: local-exec provisioner error`ブロックの`Output:`以降にも、そのまま再掲されます。

このセクションでは、情報自体は失われていないにもかかわらず、なぜ実際の障害対応の場面で失敗箇所を見つけにくくなるのかを、前セクションで取得した異常系のログをもとに整理します。

前セクションの異常系の実行結果を、改めて確認します。

```plaintext
null_resource.provision (local-exec): PLAY [local-execログ構造デモ（異常系）] ****************************************

null_resource.provision (local-exec): TASK [検証用ディレクトリを作成する] ********************************************
null_resource.provision (local-exec): [WARNING]: Platform linux on host target-node1 is using the discovered Python
null_resource.provision (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.provision (local-exec): interpreter could change the meaning of that path. See
null_resource.provision (local-exec): https://docs.ansible.com/ansible-
null_resource.provision (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.provision (local-exec): ok: [target-node1]

null_resource.provision (local-exec): TASK [存在しないディレクトリに設定ファイルを配置する（意図的に失敗させる）] ****
null_resource.provision (local-exec): fatal: [target-node1]: FAILED! => {"changed": false, "checksum": "e184461f4646921eabc5a2a0a90a001760003484", "msg": "Destination directory /etc/myapp_nonexistent_dir does not exist"}

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=1    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0

╷
│ Error: local-exec provisioner error
│
│   with null_resource.provision,
│   on main.tf line 101, in resource "null_resource" "provision":
│  101:   provisioner "local-exec" {
│
│ Error running command 'ANSIBLE_SSH_RETRIES=0 ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_error.yml': exit status 2. Output:
│ PLAY [local-execログ構造デモ（異常系）] ****************************************
│
│ TASK [検証用ディレクトリを作成する] ********************************************
│ ok: [target-node1]
│
│ TASK [存在しないディレクトリに設定ファイルを配置する（意図的に失敗させる）] ****
│ fatal: [target-node1]: FAILED! => {"changed": false, "checksum": "e184461f4646921eabc5a2a0a90a001760003484", "msg": "Destination directory /etc/myapp_nonexistent_dir does not exist"}
│
│ PLAY RECAP *********************************************************************
│ target-node1               : ok=1    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
│
│
╵
```

このログをもとに、視認性が下がる要因を整理します。

* `fatal: [target-node1]:`の行が、1回目（通常の実行ログとして）と2回目（`Output:`以降の再掲）の、離れた2箇所に存在します。この間に`PLAY RECAP`が挟まるため、同じ内容が繰り返されているという印象を持ちにくく、読者、あるいは実際の運用者は「もう一度別の失敗が起きたのか」「先ほどと同じ内容なのか」を都度判断する必要があります
* `Error: local-exec provisioner error`という見出しと、`exit status 2`という数値は、罫線（`╷`、`│`、`╵`）で装飾されているため視覚的に目立ちます。一方、実際の失敗原因である`fatal:`の行は、この装飾の外、通常のログ出力の中に埋もれています。目立つのはエラーが起きたという事実であり、何が原因かという情報は、装飾のない地の文の中にあります
* 今回の検証環境はリソース数が少なく、`null_resource.provision`単体の出力のみが表示されるため、この視認性の問題は比較的軽微です。しかし複数リソースを並列で`apply`する実際の運用では、この一連の出力の前後に他のリソースの`Refreshing state`や`Creating...`が混在するため、`PLAY RECAP`から`Error:`ブロックまでの間に無関係な行が挟まり、同じAnsible出力の2箇所がさらに離れる可能性があります。この点は今回の検証環境の制約上、実機では確認していません

この結果から分かるのは、Ansible側のエラー情報は消えているのではなく、同じ情報が2箇所に重複して存在するために、どちらが最初の失敗でどちらが再掲なのかを読者側で読み解く必要がある、という構造です。次のセクションでは、この埋没を避けるために、Ansibleのログをそもそも別ファイルへ分離して取得する方法を扱います。

---

[↑ 目次に戻る](#-目次)

---

## 4. ANSIBLE_LOG_PATHによるログの分離取得

前セクションまでで確認した埋没を防ぐため、`ANSIBLE_LOG_PATH`環境変数を使い、Ansibleの実行ログをTerraformの出力とは独立したファイルに出力する方法を確認します。

### ■ 検証内容：ANSIBLE_LOG_PATHによるログの分離取得

`null_resource.provision`の`local-exec`コマンド内で`ANSIBLE_LOG_PATH`を指定し、`test_nested_error.yml`（異常系）を実行します。ログの出力先は、作業ディレクトリ配下の`logs/`とします。

* **ファイル名：**`main.tf`（該当箇所）

```hcl
resource "null_resource" "provision" {
  depends_on = [local_file.ansible_inventory]
  provisioner "local-exec" {
    command = "ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/ansible-run.log ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_error.yml"
  }
}
```

`local-exec`の実行時のカレントディレクトリは`main.tf`と同じディレクトリになるため、`logs/ansible-run.log`という相対パスの指定で、`~/iac/docker-lab/logs/ansible-run.log`にログが出力されます。このディレクトリはあらかじめ作成しておく必要があります。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
(ansible-env) control@ubuntu-controller:~/iac/docker-lab$ terraform apply
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node2"]: Refreshing state... [id=a33463336b78be7e1b09cfef85e2b18e4cbdcdb4d7f43087e344e8fa6cb62743]
docker_container.targets["target-node1"]: Refreshing state... [id=627d7a6a9fcda8789a23e0da05bf28b2a4106f976b542562e3caa9d873e5a5e8]
docker_container.targets["target-node3"]: Refreshing state... [id=acac4b63e617b41bcb7b9f7126a58bd49c20a9e8fa4d95bf9118c088b5306fcd]
local_file.ansible_inventory: Refreshing state... [id=8d3ed4ce0d69a595289b62511d2fccc77a3907ec]
null_resource.provision: Refreshing state... [id=8225965160080939356]

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # null_resource.provision is tainted, so must be replaced
-/+ resource "null_resource" "provision" {
      ~ id = "8225965160080939356" -> (known after apply)
    }

Plan: 1 to add, 0 to change, 1 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.provision: Destroying... [id=8225965160080939356]
null_resource.provision: Destruction complete after 0s
null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/ansible-run.log ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_error.yml"]

null_resource.provision (local-exec): PLAY [local-execログ構造デモ（異常系）] ****************************************

null_resource.provision (local-exec): TASK [検証用ディレクトリを作成する] ********************************************
null_resource.provision (local-exec): [WARNING]: Platform linux on host target-node1 is using the discovered Python
null_resource.provision (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.provision (local-exec): interpreter could change the meaning of that path. See
null_resource.provision (local-exec): https://docs.ansible.com/ansible-
null_resource.provision (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.provision (local-exec): ok: [target-node1]

null_resource.provision (local-exec): TASK [存在しないディレクトリに設定ファイルを配置する（意図的に失敗させる）] ****
null_resource.provision (local-exec): fatal: [target-node1]: FAILED! => {"changed": false, "checksum": "e184461f4646921eabc5a2a0a90a001760003484", "msg": "Destination directory /etc/myapp_nonexistent_dir does not exist"}

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=1    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0

╷
│ Error: local-exec provisioner error
│
│   with null_resource.provision,
│   on main.tf line 101, in resource "null_resource" "provision":
│  101:   provisioner "local-exec" {
│
│ Error running command 'ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/ansible-run.log ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_error.yml': exit status 2. Output:
│ PLAY [local-execログ構造デモ（異常系）] ****************************************
│
│ TASK [検証用ディレクトリを作成する] ********************************************
│ [WARNING]: Platform linux on host target-node1 is using the discovered Python
│ interpreter at /usr/bin/python3.10, but future installation of another Python
│ interpreter could change the meaning of that path. See
│ https://docs.ansible.com/ansible-
│ core/2.17/reference_appendices/interpreter_discovery.html for more information.
│ ok: [target-node1]
│
│ TASK [存在しないディレクトリに設定ファイルを配置する（意図的に失敗させる）] ****
│ fatal: [target-node1]: FAILED! => {"changed": false, "checksum": "e184461f4646921eabc5a2a0a90a001760003484", "msg": "Destination directory /etc/myapp_nonexistent_dir does not exist"}
│
│ PLAY RECAP *********************************************************************
│ target-node1               : ok=1    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
│
│
╵
```

`terraform apply`はエラーで終了していますが、ここで`~/iac/docker-lab/logs/ansible-run.log`を単体で確認します。

**実行コマンド**

```plaintext
cat -n ~/iac/docker-lab/logs/ansible-run.log
```

**▼ 実行結果**

```plaintext
2026-08-24 07:59:22,374 p=17709 u=control n=ansible | PLAY [local-execログ構造デモ（異常系）] ****************************************
2026-08-24 07:59:22,382 p=17709 u=control n=ansible | TASK [検証用ディレクトリを作成する] ********************************************
2026-08-24 07:59:23,620 p=17709 u=control n=ansible | [WARNING]: Platform linux on host target-node1 is using the discovered Python
interpreter at /usr/bin/python3.10, but future installation of another Python
interpreter could change the meaning of that path. See
https://docs.ansible.com/ansible-
core/2.17/reference_appendices/interpreter_discovery.html for more information.

2026-08-24 07:59:23,620 p=17709 u=control n=ansible | ok: [target-node1]
2026-08-24 07:59:23,624 p=17709 u=control n=ansible | TASK [存在しないディレクトリに設定ファイルを配置する（意図的に失敗させる）] ****
2026-08-24 07:59:24,994 p=17709 u=control n=ansible | fatal: [target-node1]: FAILED! => {"changed": false, "checksum": "e184461f4646921eabc5a2a0a90a001760003484", "msg": "Destination directory /etc/myapp_nonexistent_dir does not exist"}
2026-08-24 07:59:24,997 p=17709 u=control n=ansible | PLAY RECAP *********************************************************************
2026-08-24 07:59:24,998 p=17709 u=control n=ansible | target-node1               : ok=1    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
```

### ■ 結果

`ANSIBLE_LOG_PATH`を指定することで、Ansibleの実行ログが`~/iac/docker-lab/logs/ansible-run.log`に独立して出力されました。このログファイルには、各行にタイムスタンプ（`2026-08-24 07:59:24,994`）、プロセスID（`p=17709`）、実行ユーザー（`u=control`）、接続タイプ（`n=ansible`）が付与されており、`fatal:`行や`PLAY RECAP`が単独で確認できます。

前セクションまでで確認した`terraform apply`のログでは、`fatal:`行が通常の実行ログとエラーブロックの`Output:`以降の2箇所に重複して現れ、罫線装飾に紛れて視認しにくい状態でした。一方、`ANSIBLE_LOG_PATH`で分離したログファイルには、Terraform側の出力や罫線装飾が一切含まれず、`fatal:`行は1回だけ、時系列に沿って記録されています。

このログファイルを直接確認すれば、`terraform apply`の出力を読み解く必要なく、どのタスクがいつ失敗したかを特定できます。次のセクションでは、この分離取得したログと、Terraform側の出力を突き合わせて原因を特定する手順を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. Terraform側とAnsible側のログを突き合わせる手順

前セクションまでで、次の2つのログが手元にあります。

* `terraform apply`の出力（`Error: local-exec provisioner error`を含む、Terraform側の実行ログ）
* `ANSIBLE_LOG_PATH`で分離取得した`~/iac/docker-lab/logs/ansible-run.log`（Ansible単体の実行ログ）

このセクションでは、この2つのログを実際にどう突き合わせて原因を特定するか、手順として整理します。

### 手順

**① `terraform apply`の出力から、エラーが発生したリソース名を確認する**

`Error: local-exec provisioner error`ブロックの`with`行に、エラーが発生したリソース名が示されています。

```plaintext
│ Error: local-exec provisioner error
│
│   with null_resource.provision,
│   on main.tf line 101, in resource "null_resource" "provision":
```

今回の検証では`null_resource.provision`です。`main.tf`が複数の`null_resource`を持つ構成であれば、この行でどの`local-exec`が失敗したかをまず特定します。

**② ANSIBLE_LOG_PATHのログファイルを確認し、該当する実行区間を特定する**

`~/iac/docker-lab/logs/ansible-run.log`を開き、直近の実行区間を確認します。

```plaintext
2026-08-24 07:59:22,374 p=17709 u=control n=ansible | PLAY [local-execログ構造デモ（異常系）] ****************************************
```

`PLAY`行のタイムスタンプが、実行区間の起点になります。今回のログはこの1回の実行のみが記録されていますが、同じログファイルに複数回分の実行履歴が蓄積されている場合は、`terraform apply`を実行した時刻に最も近い`PLAY`行を探すことで、該当する実行区間を絞り込みます。

**③ その区間内のPLAY RECAPで、failed/unreachableになっているホスト、タスクを確認する**

```plaintext
2026-08-24 07:59:24,997 p=17709 u=control n=ansible | PLAY RECAP *********************************************************************
2026-08-24 07:59:24,998 p=17709 u=control n=ansible | target-node1               : ok=1    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
```

`failed=1`から、target-node1で1件のタスクが失敗したことが分かります。

**④ 該当タスクの詳細出力（エラーメッセージ）を確認する**

`PLAY RECAP`から時系列を遡り、`fatal:`で始まる行を探します。

```plaintext
2026-08-24 07:59:24,994 p=17709 u=control n=ansible | fatal: [target-node1]: FAILED! => {"changed": false, "checksum": "e184461f4646921eabc5a2a0a90a001760003484", "msg": "Destination directory /etc/myapp_nonexistent_dir does not exist"}
```

`msg`の内容から、`/etc/myapp_nonexistent_dir`というディレクトリが存在しないことが原因と特定できます。

### この手順で分かること

この手順を通じて、「①Terraform側のどのリソースのapply中に失敗したか」と「④Ansible側のどのタスクが、どういう理由で失敗したか」が、1つの原因として接続されます。

前セクションまでで確認した通り、`terraform apply`の出力単体でも同じ情報（`fatal:`行）は含まれています。しかし、`ANSIBLE_LOG_PATH`で分離したログファイルを使うことで、罫線装飾や重複表示に紛れることなく、タイムスタンプに沿って該当箇所へ直接たどり着けます。特に、実行のたびにログファイルへ追記される運用にしておけば、`terraform apply`のターミナル出力がスクロールで流れてしまった後でも、ログファイル側から過去の実行結果を遡って確認できるという利点があります。

---

[↑ 目次に戻る](#-目次)

---



## 6. ログ遮蔽問題と実行失敗問題の切り分け

ここまでのセクションで扱ってきたのは、「Ansibleが実際に失敗したとき、その失敗箇所がログ上でどう見えるか」という可視性の問題でした。一方で、「なぜAnsibleの実行自体が失敗するのか」という原因そのものは、この回では扱っていません。この2つは別軸の問題であり、混同すると整理が難しくなるため、ここで切り分けておきます。

今回の検証で使った`test_nested_error.yml`が失敗した直接の原因は、「存在しないディレクトリへの`copy`」という、あらかじめ意図して仕込んだ単純な設定ミスでした。しかし、実際の運用で`local-exec`経由のAnsible実行が失敗する原因は、これよりも複雑な構造を持つケースがあります。

* **[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)** で扱った冪等性の崩れは、`local-exec`経由でAnsibleが複数回実行される構成において、1回目は成功したPlaybookが2回目以降の実行で失敗するという、実行回数に依存する原因でした
* **[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**（第3部後半） で扱う予定の、再起動、再生成に伴う接続断絶は、Ansible実行中に対象ホストとの接続そのものが失われることで失敗するという、実行中の状態変化に依存する原因です

これらは、いずれも「なぜAnsibleの実行が失敗するのか」という原因側の問題であり、この回で整理してきた「失敗した結果がログ上でどう見えるか」という可視性側の問題とは、別の軸にあります。

この2つの軸の関係を整理すると、次のようになります。
```

原因側の問題（なぜ失敗するのか）  
　→ 第14回（冪等性の崩れ）、第27回（接続断絶）等、個別の回で扱う

可視性側の問題（失敗がどう見えるか）  
　→ 第21回（この回）が扱う、ログの構造そのもの

```

第21回で整理したログの読み解き方（セクション2〜5）は、原因が何であれ、`local-exec`経由でAnsibleが失敗したときに共通して使える手段です。**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)** のような冪等性の崩れが原因であっても、**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** のような接続断絶が原因であっても、失敗の結果は同じく`Error: local-exec provisioner error`という形でTerraformのログに現れ、同じ手順で`ANSIBLE_LOG_PATH`のログと突き合わせることができます。

つまり、この回で整理した手法は、特定の原因に紐づくものではなく、原因を特定するための前提となる、共通の土台にあたります。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* `local-exec`は失敗したコマンドの出力を握りつぶしているわけではない。異常終了時、Ansibleの実行結果（`PLAY`から`PLAY RECAP`まで）は通常の実行ログとして一度流れたのち、`Error: local-exec provisioner error`ブロックの`Output:`以降にも、そのまま再掲される
* 情報自体は失われていないが、`fatal:`行が離れた2箇所に重複して存在すること、罫線装飾によって`exit status`という数値の方が視覚的に目立つことから、実際の失敗箇所を見つけにくくなる
* `ANSIBLE_LOG_PATH`環境変数を指定することで、Ansibleの実行ログをTerraformの出力とは独立したファイルに分離取得できる。分離したログには罫線装飾や重複がなく、タイムスタンプに沿って`fatal:`行を1回だけ確認できる
* Terraform側のエラーメッセージからリソース名を特定し、ANSIBLE_LOG_PATHのログファイルを時系列で確認するという手順を踏むことで、「どのリソースのapply中に」「どのタスクが、どういう理由で」失敗したかを1つの原因として接続できる
* この回で整理したログの読み解き方は、冪等性の崩れ（**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**）や接続断絶（**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**）など、失敗の原因が何であれ共通して使える手段である。「なぜ失敗するか」という原因側の問題と、「失敗がどう見えるか」という可視性側の問題は、別の軸として切り分けて考える必要がある

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

第2部（第11〜20回）では、TerraformとAnsibleそれぞれの管理範囲の違いによって生じる構造的な問題を扱ってきました。第3部の初回となる今回は、視点を「設計、運用による予防」から「障害発生時の原因特定」に切り替え、`local-exec`経由でAnsibleを実行した際にエラーログがどう変質するかを整理しました。Terraformのエラーメッセージがコマンドの出力を握りつぶしているわけではないこと、しかし罫線装飾と重複表示によって実際の失敗箇所が見えにくくなること、そして`ANSIBLE_LOG_PATH`による分離取得がこの視認性の問題を解消する手段になることを、実機検証を交えて確認しました。

次回は、この「見え方」の問題から離れ、Ansible接続そのものが意図しない経路を通ってしまう問題を扱います。複数のDockerネットワークをアタッチした環境で、Ansibleが接続に使うインターフェースが意図せず切り替わり、`ansible_default_ipv4`のようなファクトが想定と異なる値を返すことで、接続エラーの原因特定がさらに複雑になる構造を整理します。

**[次回：第22回：マルチネットワーク環境におけるインターフェース競合](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-20/)　｜　[次の記事：【Ansible×Terraform編】第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第3部：トラブルシューティング、デバッグ編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**|統合実行時におけるネストされたエラーログの解析手法|Terraformの`local-exec`経由で実行されたAnsibleのエラーログから、原因がTerraform側（HCL、State）かAnsible側（Playbook、タスク）かを特定する手法。|
|**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)**|マルチネットワーク環境におけるインターフェース競合|複数ネットワーク（Dockerネットワーク等）をアタッチした際、Ansibleの`ansible_default_ipv4`や接続IPの自動検出が意図しないインターフェースに引きずられる問題。|
|**[第23回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)**|大容量ファイル転送、重いタスク実行時におけるSSHタイムアウト|Ansibleで大きなアセットや大量のパッケージを転送、適用する際、Terraform側のプロビジョナータイムアウトに引っかかる可能性がある問題を扱う。|
|**[第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)**|並列実行時における実行ホストのシステムリソース枯渇対策|`parallelism`や`forks`設定により、大量のリソース構築とAnsibleプロビジョニングが同時に走った場合、ホストのCPU、メモリ、ファイルディスクリプタが枯渇しうる問題を扱う。|
|**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)**|構文チェックツール（HCL構文、ansible-lint）の競合緩和|両ツールの静的解析ツール（`terraform fmt`、`ansible-lint`）を導入した際、コード記述ルールや命名規則の不一致でCIが通らなくなる問題。|
|**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**|管理者権限（sudo）実行時におけるパスワード入力のプロンプト停止|Terraformの`local-exec`や非対話シェルからAnsibleを実行した際、`sudo: a terminal is required to read the password`で停止する問題。|
|**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**|再起動、再生成に伴うプロビジョニング断絶|Ansibleでカーネル更新等のためにOS再起動（またはコンテナ再起動、再生成）を要求した際、接続が途切れTerraformがエラー扱いする問題。|
|**[第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)**|異種OS（Windowsターゲット）混在環境における接続プロトコルの制約|SSHではなくWinRM等を用いる特殊プロトコル環境での接続、権限エラー。実務でWindows ServerをAnsible×Terraformで管理する際の構造的注意点を扱う概念解説回。|
|**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)**|プロキシ環境等における外部コレクション（Ansible Galaxy）の取得失敗|インフラ構築処理の途中で外部ネットワーク（Ansible Galaxy等）への依存が切れ、Terraformの処理全体が失敗する問題。|
|**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)**|デバッグフラグの組み合わせによるログ解析の高度化|Terraformの`TF_LOG`とAnsibleの`-vvvv`を組み合わせ、接続遅延や処理遅延のボトルネックを特定、解消する手法。|

---

[↑ 目次に戻る](#-目次)

---