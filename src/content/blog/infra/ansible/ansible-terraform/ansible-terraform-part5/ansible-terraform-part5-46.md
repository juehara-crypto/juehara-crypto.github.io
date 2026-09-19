---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第46回：プロビジョニング途中の接続切断とState不整合（ハーフデプロイ状態）'
description: 'local-execプロビジョナーによるAnsible実行が異常終了した際、Terraformがリソースをtaintedとしてマークし、リソースの作成完了とプロビジョニング未完了が併存するハーフデプロイ状態が生じる構造を整理する。接続切断やプロセス停止の中断パターンを類型化し、taint状態の実態を実機で確認する。'
pubDate: 2026-09-16
category: 'infra'
tags: ['Ansible', 'Terraform', 'lifecycle', 'tainted', 'local-exec']
seriesId: 'ansible-terraform-part5'
seriesNo: 46
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/'
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
2. [creation-time provisioner失敗時のtainted化](#2-creation-time-provisioner失敗時のtainted化)
3. [tainted状態の実態](#3-tainted状態の実態)
4. [接続切断、プロセス停止のパターン整理](#4-接続切断プロセス停止のパターン整理)
5. [ハーフデプロイ状態での次の一手](#5-ハーフデプロイ状態での次の一手)
6. [まとめ](#6-まとめ)
7. [次回予告](#7-次回予告)
8. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#8-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

Terraformによるリソースの再生成は、常にユーザーが意図した変更によって引き起こされるとは限りません。

**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** では`lifecycle`ブロックによる強制再生成、**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)** では`prevent_destroy`とAnsible再実行要求とのバッティング、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** ではリソース再生成に伴うデータ消失、**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** では依存リソースの変更による連鎖的な再生成を、それぞれ実機で確認しました。いずれの回も、ユーザーが明示的に行ったコード変更が起点となり、Terraformが「意図的に」リソースを破棄、再生成する場面でした。

第46回となる今回は、この前提が変わります。コード変更ではなく、Ansibleのプロビジョニング実行中に発生する接続の切断やプロセスの停止という事故によって、Terraformが意図せず中途半端な状態に陥るケースを扱います。

この回で扱う問いは、「途中で止まったら、Terraformは何を『できた』と記録するのか」です。

次のセクションでは、この問いの出発点となる、`local-exec`によるプロビジョニングが失敗した際にTerraformが行う基本的な挙動を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. creation-time provisioner失敗時のtainted化

異常終了時にTerraformが何を記録するかを整理するセクションです。

`local-exec`のようなcreation-time provisionerが異常終了した場合、Terraformはそのプロビジョナーが定義されているリソースをtaintedとしてマークします。これは「リソース自体の作成は完了しているが、それに続くプロビジョニングが正常に完了しなかった」ことを示す状態であり、次回の`terraform apply`実行時に、このリソースは破棄、再作成の対象になります。

検証環境では、Ansible実行は`null_resource.provision`の`local-exec`プロビジョナー（`ansible-playbook -i inventory.ini site.yml`）が担っています。`local-exec`はこの`null_resource.provision`自体に定義されているため、taintedとしてマークされるのは`null_resource.provision`であり、Ansibleの実行対象であるtarget-node1〜3（`docker_container.targets`）ではありません。

### ■ 検証内容：`local-exec`が異常終了するタスクの追加

Ansible実行が一部のタスクを完了した後に失敗するよう、既存のPlaybook（`roles/common_setup/tasks/apt_cache.yml`）に検証用タスクを追加します。

* **ファイル名：`roles/common_setup/tasks/apt_cache.yml`**

【変更前】

```yaml
---
- name: apt-cacher-ng経由でaptパッケージを取得するようプロキシを設定
  become: true
  ansible.builtin.copy:
    dest: /etc/apt/apt.conf.d/02proxy
    content: 'Acquire::http::Proxy "http://172.20.0.1:3142";'
```

【変更後】

```yaml
---
- name: apt-cacher-ng経由でaptパッケージを取得するようプロキシを設定
  become: true
  ansible.builtin.copy:
    dest: /etc/apt/apt.conf.d/02proxy
    content: 'Acquire::http::Proxy "http://172.20.0.1:3142";'

- name: 【検証用】存在しないコマンドでタスクを失敗させる
  ansible.builtin.command: this_command_does_not_exist_either
```

`common`ロール（hostnameの取得、表示の2タスク）、`common_setup`ロールのapt-cacherプロキシ設定タスクは変更せず、末尾に`ansible.builtin.command`で存在しないコマンドを実行させるタスクを追加します。実在するモジュールをランタイムで失敗させることで、Ansible実行が一部のタスクを完了した後に停止する状態を再現します。

この状態で`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # null_resource.provision is tainted, so must be replaced
-/+ resource "null_resource" "provision" {
      ~ id       = "8547718717552897119" -> (known after apply)
      ~ triggers = {
          ~ "playbook_hash" = "dfb3c1ee72c05728d2a2ef88c2dfcac45d12b8cf1de07796a0ea7b8bd430d5c5" -> "806eb02faf2f90826d2abe7db86416b8c988d8f064315919400739964d95be72"
        }
    }

Plan: 1 to add, 0 to change, 1 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.provision: Destroying... [id=8547718717552897119]
null_resource.provision: Destruction complete after 0s
null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ansible-playbook -i inventory.ini site.yml"]

null_resource.provision (local-exec): PLAY [接続確認用Playbook] ******************************************************

null_resource.provision (local-exec): TASK [common : 疎通確認（common role・第35回更新）] ****************************
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
null_resource.provision (local-exec): [WARNING]: Platform linux on host target-node3 is using the discovered Python
null_resource.provision (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.provision (local-exec): interpreter could change the meaning of that path. See
null_resource.provision (local-exec): https://docs.ansible.com/ansible-
null_resource.provision (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.provision (local-exec): ok: [target-node2]
null_resource.provision (local-exec): ok: [target-node1]
null_resource.provision (local-exec): ok: [target-node3]

null_resource.provision (local-exec): TASK [common_setup : apt-cacher-ng経由でaptパッケージを取得するようプロキシを設定] ***
null_resource.provision (local-exec): changed: [target-node1]
null_resource.provision (local-exec): changed: [target-node3]
null_resource.provision (local-exec): changed: [target-node2]

null_resource.provision (local-exec): TASK [common_setup : 【検証用】存在しないコマンドでタスクを失敗させる] *********
null_resource.provision (local-exec): fatal: [target-node1]: FAILED! => {"changed": false, "cmd": "this_command_does_not_exist_either", "msg": "[Errno 2] No such file or directory: b'this_command_does_not_exist_either'", "rc": 2, "stderr": "", "stderr_lines": [], "stdout": "", "stdout_lines": []}
null_resource.provision (local-exec): fatal: [target-node2]: FAILED! => {"changed": false, "cmd": "this_command_does_not_exist_either", "msg": "[Errno 2] No such file or directory: b'this_command_does_not_exist_either'", "rc": 2, "stderr": "", "stderr_lines": [], "stdout": "", "stdout_lines": []}
null_resource.provision (local-exec): fatal: [target-node3]: FAILED! => {"changed": false, "cmd": "this_command_does_not_exist_either", "msg": "[Errno 2] No such file or directory: b'this_command_does_not_exist_either'", "rc": 2, "stderr": "", "stderr_lines": [], "stdout": "", "stdout_lines": []}

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=2    changed=1    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node2               : ok=2    changed=1    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node3               : ok=2    changed=1    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0

╷
│ Error: local-exec provisioner error
│
│   with null_resource.provision,
│   on main.tf line 146, in resource "null_resource" "provision":
│  146:   provisioner "local-exec" {
│
│ Error running command 'ansible-playbook -i inventory.ini site.yml': exit status 2. Output:
│ PLAY [接続確認用Playbook] ******************************************************
│
│ TASK [common : 疎通確認（common role・第35回更新）] ****************************
│ [WARNING]: Platform linux on host target-node2 is using the discovered Python
│ interpreter at /usr/bin/python3.10, but future installation of another Python
│ interpreter could change the meaning of that path. See
│ https://docs.ansible.com/ansible-
│ core/2.17/reference_appendices/interpreter_discovery.html for more information.
│ [WARNING]: Platform linux on host target-node1 is using the discovered Python
│ interpreter at /usr/bin/python3.10, but future installation of another Python
│ interpreter could change the meaning of that path. See
│ https://docs.ansible.com/ansible-
│ core/2.17/reference_appendices/interpreter_discovery.html for more information.
│ [WARNING]: Platform linux on host target-node3 is using the discovered Python
│ interpreter at /usr/bin/python3.10, but future installation of another Python
│ interpreter could change the meaning of that path. See
│ https://docs.ansible.com/ansible-
│ core/2.17/reference_appendices/interpreter_discovery.html for more information.
│ ok: [target-node2]
│ ok: [target-node1]
│ ok: [target-node3]
│
│ TASK [common_setup : apt-cacher-ng経由でaptパッケージを取得するようプロキシを設定] ***
│ changed: [target-node1]
│ changed: [target-node3]
│ changed: [target-node2]
│
│ TASK [common_setup : 【検証用】存在しないコマンドでタスクを失敗させる] *********
│ fatal: [target-node1]: FAILED! => {"changed": false, "cmd": "this_command_does_not_exist_either", "msg": "[Errno 2] No such file or directory: b'this_command_does_not_exist_either'",
│ "rc": 2, "stderr": "", "stderr_lines": [], "stdout": "", "stdout_lines": []}
│ fatal: [target-node2]: FAILED! => {"changed": false, "cmd": "this_command_does_not_exist_either", "msg": "[Errno 2] No such file or directory: b'this_command_does_not_exist_either'",
│ "rc": 2, "stderr": "", "stderr_lines": [], "stdout": "", "stdout_lines": []}
│ fatal: [target-node3]: FAILED! => {"changed": false, "cmd": "this_command_does_not_exist_either", "msg": "[Errno 2] No such file or directory: b'this_command_does_not_exist_either'",
│ "rc": 2, "stderr": "", "stderr_lines": [], "stdout": "", "stdout_lines": []}
│
│ PLAY RECAP *********************************************************************
│ target-node1               : ok=2    changed=1    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
│ target-node2               : ok=2    changed=1    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
│ target-node3               : ok=2    changed=1    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
│
│
╵
```

`common`ロールの疎通確認タスク（`ok`×3）、`common_setup`ロールのapt-cacherプロキシ設定タスク（`changed`×3）は正常に完了し、末尾の検証用タスクで3台とも`fatal`となりました。`ansible-playbook`は`exit status 2`で異常終了し、Terraformはこれを`local-exec provisioner error`として受け取っています。

### ■ 検証内容：`terraform show`によるtainted状態の確認

`terraform apply`が失敗に終わった後の状態を確認します。

**実行コマンド**

```plaintext
terraform show
```

**▼実行結果**

```plaintext
（途中省略：docker_network.app_net、docker_network.lab_net、local_file.ansible_inventory、local_file.group_vars_target_nodes、local_file.private_key、null_resource.fix_permission、tls_private_key.generated、module.image_*の出力）

# docker_container.targets["target-node1"]:
resource "docker_container" "targets" {
    id                                           = "9783af80daab946f6e602d96bc8a0a9b650a51c5c82b63ead2ef3bfe0e2afd88"
    name                                         = "target-node1"
    # (以下省略：taint化の確認に関係しない属性)
}

# docker_container.targets["target-node2"]:
resource "docker_container" "targets" {
    id                                           = "3e073905557972ae1dbc87110e51076468a33b2c1c2c82e15ef5d6b8e677e9c4"
    name                                         = "target-node2"
    # (以下省略：taint化の確認に関係しない属性)
}

# docker_container.targets["target-node3"]:
resource "docker_container" "targets" {
    id                                           = "e4bd329b00d7469a33f9343d340100c1495553a2dc4232ef4c5a0910e4525f9c"
    name                                         = "target-node3"
    # (以下省略：taint化の確認に関係しない属性)
}

# null_resource.provision: (tainted)
resource "null_resource" "provision" {
    id       = "8494520600922553909"
    triggers = {
        "playbook_hash" = "806eb02faf2f90826d2abe7db86416b8c988d8f064315919400739964d95be72"
    }
}
```

`docker_container.targets`3台にはtainted相当の記載がなく、`terraform apply`実行前と同一の`id`のままです。一方`null_resource.provision`には`(tainted)`という注記が付いており、`id`も実行前（`8547718717552897119`）とは異なる値（`8494520600922553909`）に変わっています。

続けて、コンテナ自体の状態を`docker`側からも確認します。

**実行コマンド**

```plaintext
docker ps -a
```

**▼実行結果**

```plaintext
CONTAINER ID   IMAGE          COMMAND               CREATED       STATUS       PORTS                  NAMES
e4bd329b00d7   32ab5c4e8d48   "/usr/sbin/sshd -D"   3 hours ago   Up 3 hours   0.0.0.0:2223->22/tcp   target-node3
3e0739055579   32ab5c4e8d48   "/usr/sbin/sshd -D"   3 hours ago   Up 3 hours   0.0.0.0:2222->22/tcp   target-node2
9783af80daab   32ab5c4e8d48   "/usr/sbin/sshd -D"   3 hours ago   Up 3 hours   0.0.0.0:2231->22/tcp   target-node1
```

target-node1〜3すべて`Up`状態で稼働し続けており、`terraform apply`のエラー終了による影響を受けていません。

### ■ 結果

`local-exec`によるAnsible実行が一部のタスクを完了した後に異常終了した場合、Terraformはそのプロビジョナーが定義されている`null_resource.provision`をtaintedとしてマークすることが確認できました。プロビジョニングの対象であるtarget-node1〜3（`docker_container.targets`）は、`terraform apply`実行前と同一の状態のまま影響を受けていません。taintedになるのは、Ansible実行を担うプロビジョナー自体を保持しているリソースであり、プロビジョニングの対象であるコンテナ本体ではない、という点がこの回の前提になります。

次のセクションでは、このtainted状態が実際にどのような食い違いを生んでいるのかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. tainted状態の実態

taintedとしてマークされる対象が何であるかを整理するセクションです。

セクション2で確認した通り、`local-exec`によるAnsible実行が異常終了した場合、taintedとしてマークされるのは、そのプロビジョナーが定義されているリソース、つまり`null_resource.provision`です。プロビジョニングの対象であるコンテナ（`docker_container.targets`）ではありません。

この点は、tainted状態の実態を理解するうえで重要です。`docker_network`や`docker_container`のように、Docker Engine上に実際の実体を持つリソースであれば、「実体は残っているのにtfstate上は破棄予定として記録されている」という食い違いが生じ得ます。しかし`null_resource`は、Docker側に対応する実体を一切持たない、Terraformの記録上だけのリソースです。
```

【実際のDocker側】  
target-node1〜3のコンテナは、terraform apply失敗前後で一切変化なし  
docker ps -aで継続稼働を確認

【tfstate上の記録】  
null_resource.provision がtaintedとしてマークされる  
　→ 次回applyで破棄、再作成の対象  
　→ 「破棄、再作成」の実体は、local-execの再実行（Ansibleの再実行）そのもの

```

`null_resource`の「破棄」は、Docker Engine上で何かを削除する操作ではありません。`null_resource`自体が何の実体も持たないため、その「破棄、再作成」は、`local-exec`プロビジョナー（今回であれば`ansible-playbook -i inventory.ini site.yml`）をもう一度実行する、という結果にしかなりません。

つまり、tainted状態が示しているのは「コンテナが不安定な状態にある」ということではなく、「次回のapplyでAnsibleの実行が再試行される」ということです。プロビジョニングの対象であるコンテナ自体は、`terraform apply`が異常終了した時点の状態のまま保たれます。

次のセクションでは、このtainted状態を引き起こす、接続切断、プロセス停止の中断パターンを整理します。


---

[↑ 目次に戻る](#-目次)

---

## 4. 接続切断、プロセス停止のパターン整理

`local-exec`が異常終了に至る中断のパターンを整理するセクションです。

セクション2の検証では、Ansibleの通常のタスク失敗（`ansible.builtin.command`による、存在しないコマンドの実行エラー）を使って`local-exec`を異常終了させました。しかし、`local-exec`が異常終了する原因は、タスク自体の失敗に限りません。Ansibleのプロビジョニング実行中に発生しうる中断には、いくつかの類型があります。

* **SSH接続そのものの切断**：ネットワークの瞬断等により、コントロールノードとtarget-nodeの間のSSHセッションが途中で切れるケース
* **コントロールノード側のAnsibleプロセスの強制停止**：`ansible-playbook`プロセス自体が、何らかの理由で強制終了させられるケース
* **実行時間超過によるタイムアウト**：Ansible側、あるいは呼び出し元であるTerraformの`local-exec`側で設定されたタイムアウトにより、実行中の処理が打ち切られるケース

これらは、発生する原因も現象もそれぞれ異なります。SSH接続の切断は通信経路側の問題であり、プロセスの強制停止はコントロールノード側の操作、タイムアウトは実行時間の超過という、性質の異なる事象です。

しかし、いずれのパターンも、結果として`ansible-playbook`が非ゼロの終了コードを返し、`local-exec`プロビジョナーがエラーとしてTerraformに報告される、という点では共通しています。Terraform側から見れば、SSH接続の切断が原因であっても、プロセスの強制停止が原因であっても、`local-exec`が異常終了したという事実だけが見えており、その先の原因を区別することはありません。セクション2で確認したtainted化の挙動は、この中断の原因が何であるかに関わらず、一貫して発生します。

第46回では、OSの再起動（reboot）に限定せず、このようなプロビジョニング途中の事故全般を扱います。次のセクションでは、このtainted状態が発生した後、実際に何が起きるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. ハーフデプロイ状態での次の一手

taint済みのリソースに対して次の`terraform apply`を実行すると何が起きるかを整理するセクションです。

セクション3で整理した通り、`null_resource.provision`のtaintedは、次回applyでこのリソードが破棄、再作成されることを意味します。`null_resource`自体はDocker側に実体を持たないため、この「破棄、再作成」は実質的に`local-exec`プロビジョナー（Ansible実行）の再試行です。

セクション2の検証用タスク（存在しないコマンドを実行させるタスク）を元に戻し、この状態で`terraform plan`を実行します。

### ■ 検証内容：検証用タスクの削除

異常終了の原因だった検証用タスクを、`roles/common_setup/tasks/apt_cache.yml`から取り除きます。

* **ファイル名：`roles/common_setup/tasks/apt_cache.yml`**

【変更前】

```yaml
---
- name: apt-cacher-ng経由でaptパッケージを取得するようプロキシを設定
  become: true
  ansible.builtin.copy:
    dest: /etc/apt/apt.conf.d/02proxy
    content: 'Acquire::http::Proxy "http://172.20.0.1:3142";'

- name: 【検証用】存在しないコマンドでタスクを失敗させる
  ansible.builtin.command: this_command_does_not_exist_either
```

【変更後】

```yaml
---
- name: apt-cacher-ng経由でaptパッケージを取得するようプロキシを設定
  become: true
  ansible.builtin.copy:
    dest: /etc/apt/apt.conf.d/02proxy
    content: 'Acquire::http::Proxy "http://172.20.0.1:3142";'
```

この状態で`terraform plan`を実行します。

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

  # null_resource.provision is tainted, so must be replaced
-/+ resource "null_resource" "provision" {
      ~ id       = "8494520600922553909" -> (known after apply)
      ~ triggers = {
          ~ "playbook_hash" = "806eb02faf2f90826d2abe7db86416b8c988d8f064315919400739964d95be72" -> "751f66d23dc0f2100be2ce26ec6dde8ca6aaeb72560f13ba17fe270fb65ba88b"
        }
    }

Plan: 1 to add, 0 to change, 1 to destroy.

────────────────────────────────────────────────────────────────────────────────────────────── ──────────────────────────────────────────────────────────────────────────────────────────────

Note: You didn't use the -out option to save this plan, so Terraform can't guarantee to take exactly these actions if you run "terraform apply" now.
```

`null_resource.provision is tainted, so must be replaced`という表記から、taint状態が次回のplanにも引き継がれていることが確認できます。対象は`null_resource.provision`のみで、`docker_container.targets`を含む他のリソードには差分がありません。

### ■ 検証内容：`terraform apply`によるtainted状態の解消

この計画で`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # null_resource.provision is tainted, so must be replaced
-/+ resource "null_resource" "provision" {
      ~ id       = "8494520600922553909" -> (known after apply)
      ~ triggers = {
          ~ "playbook_hash" = "806eb02faf2f90826d2abe7db86416b8c988d8f064315919400739964d95be72" -> "751f66d23dc0f2100be2ce26ec6dde8ca6aaeb72560f13ba17fe270fb65ba88b"
        }
    }

Plan: 1 to add, 0 to change, 1 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.provision: Destroying... [id=8494520600922553909]
null_resource.provision: Destruction complete after 0s
null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ansible-playbook -i inventory.ini site.yml"]

null_resource.provision (local-exec): PLAY [接続確認用Playbook] ******************************************************

null_resource.provision (local-exec): TASK [common : 疎通確認（common role・第35回更新）] ****************************
null_resource.provision (local-exec): [WARNING]: Platform linux on host target-node1 is using the discovered Python
null_resource.provision (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.provision (local-exec): interpreter could change the meaning of that path. See
null_resource.provision (local-exec): https://docs.ansible.com/ansible-
null_resource.provision (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.provision (local-exec): [WARNING]: Platform linux on host target-node2 is using the discovered Python
null_resource.provision (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.provision (local-exec): interpreter could change the meaning of that path. See
null_resource.provision (local-exec): https://docs.ansible.com/ansible-
null_resource.provision (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.provision (local-exec): [WARNING]: Platform linux on host target-node3 is using the discovered Python
null_resource.provision (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.provision (local-exec): interpreter could change the meaning of that path. See
null_resource.provision (local-exec): https://docs.ansible.com/ansible-
null_resource.provision (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.provision (local-exec): ok: [target-node1]
null_resource.provision (local-exec): ok: [target-node2]
null_resource.provision (local-exec): ok: [target-node3]

null_resource.provision (local-exec): TASK [common_setup : apt-cacher-ng経由でaptパッケージを取得するようプロキシを設定] ***
null_resource.provision (local-exec): ok: [target-node1]
null_resource.provision (local-exec): ok: [target-node2]
null_resource.provision (local-exec): ok: [target-node3]

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

null_resource.provision: Creation complete after 4s [id=785978537949375371]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.

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

`Apply complete! Resources: 1 added, 0 changed, 1 destroyed`で正常に完了しました。`null_resource.provision`の`id`は`8494520600922553909`から`785978537949375371`に変わっています。Ansible実行は`PLAY RECAP`で3台とも`ok=2 changed=0 failed=0`となり、正常に完了しています（apt-cacherプロキシ設定はセクション2の`apply`ですでに反映済みのため、今回は`changed`ではなく`ok`のみです）。

### ■ 検証内容：tainted状態の解消確認

`terraform show`と`docker ps -a`で、tainted状態の解消とコンテナへの影響有無を確認します。

**実行コマンド**

```plaintext
terraform show
```

**▼実行結果**

```plaintext
（途中省略：docker_container.targets["target-node1"]、["target-node2"]、["target-node3"]の全属性。terraform apply実行前と完全に一致しており、変化なし）

（途中省略：docker_network.app_net、docker_network.lab_net、local_file.ansible_inventory、local_file.group_vars_target_nodes、local_file.private_key、null_resource.fix_permission、tls_private_key.generated、module.image_ansible_target.docker_image.this、module.image_deploy_nopasswd.docker_image.this、module.image_deploy_passwd.docker_image.this、module.image_legacy.docker_image.thisの出力。いずれも変更なし）

# null_resource.provision:
resource "null_resource" "provision" {
    id       = "785978537949375371"
    triggers = {
        "playbook_hash" = "751f66d23dc0f2100be2ce26ec6dde8ca6aaeb72560f13ba17fe270fb65ba88b"
    }
}

（途中省略：Outputsセクション。変更なし）
```

`null_resource.provision`の見出しから`(tainted)`の注記が消え、通常のリソードとして表示されています。

**実行コマンド**

```plaintext
docker ps -a
```

**▼実行結果**

```plaintext
CONTAINER ID   IMAGE          COMMAND               CREATED       STATUS       PORTS                  NAMES
e4bd329b00d7   32ab5c4e8d48   "/usr/sbin/sshd -D"   3 hours ago   Up 3 hours   0.0.0.0:2223->22/tcp   target-node3
3e0739055579   32ab5c4e8d48   "/usr/sbin/sshd -D"   3 hours ago   Up 3 hours   0.0.0.0:2222->22/tcp   target-node2
9783af80daab   32ab5c4e8d48   "/usr/sbin/sshd -D"   3 hours ago   Up 3 hours   0.0.0.0:2231->22/tcp   target-node1
```

target-node1〜3すべて、`terraform apply`失敗前から一貫して`Up`状態のままです。

### ■ 結果

taint済みの`null_resource.provision`に対して次の`terraform apply`を実行すると、`null_resource.provision`のみが破棄、再作成され、その内実は`local-exec`（Ansible実行）の再試行でした。異常終了の原因だったタスクを取り除いた状態で再試行した結果、Ansibleは正常に完了し、tainted状態は解消されました。この間、target-node1〜3のコンテナは一貫して無傷のまま保たれています。

**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)**、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** で扱った「リソースの破棄、再作成に伴うAnsible生成データの消失」は、あくまで`docker_container`のようなDocker側に実体を持つリソースが再生成対象になった場合の結果です。`null_resource.provision`のtaintedは、この種のデータ消失には直結しません。次回applyでの再試行が失敗の原因を取り除いたものであれば、コンテナに一切触れることなく、プロビジョニングの不整合は収束します。

次のセクションでは、この回で整理した内容をまとめます。


---

[↑ 目次に戻る](#-目次)

---

## 6. まとめ

この回で整理した内容を確認します。

* `local-exec`のようなcreation-time provisionerが異常終了すると、Terraformはそのプロビジョナーが定義されているリソースをtaintedとしてマークすることを実機で確認した。taintedになるのはプロビジョナー自体が属するリソースであり、プロビジョニングの対象であるリソースそのものではない
* 検証環境では、Ansible実行を担う`null_resource.provision`がtaintedとしてマークされ、プロビジョニング対象であるtarget-node1〜3（`docker_container.targets`）は`terraform apply`失敗前後で一切変化がないことを実機で確認した
* SSH接続の切断、コントロールノード側のプロセス強制停止、実行時間超過によるタイムアウトは、発生する原因や現象がそれぞれ異なるものの、いずれも`local-exec`が非ゼロの終了コードを返すという点で共通しており、Terraform側から見れば同じtaint化という結果に集約されることを整理した
* `null_resource`はDocker側に対応する実体を持たないため、taintedの「破棄、再作成」は実質的に`local-exec`プロビジョナー（Ansible実行）の再試行にすぎないことを整理した
* 異常終了の原因だったタスクを取り除いた状態で再度`terraform apply`を実行すると、Ansibleは正常に完了し、tainted状態は解消されることを実機で確認した。この間、target-node1〜3のコンテナは一貫して無傷のまま保たれた
* **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)**、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)**、**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** で確認したAnsible生成データの消失は、`docker_container`のようなDocker側に実体を持つリソースが破棄、再生成の対象になった場合に発生するものであり、`null_resource`のtaint化とは異なる構造であることが今回の実機検証で確認できた

---

[↑ 目次に戻る](#-目次)

---

## 7. 次回予告

第46回となる今回は、Ansibleのプロビジョニング実行中の接続切断、プロセス停止によって生じるtainted状態を扱いました。taintedとしてマークされるのはプロビジョニングを担うリソース自体であり、プロビジョニングの対象であるコンテナは、この事故の影響を直接受けないことを実機で確認しました。

一方で、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)**、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)**、**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)** で確認してきた通り、コード変更やリソース間の依存関係を起点とした破棄、再生成そのものは、依然としてAnsible生成データの消失というリスクを伴います。

次回は、この再生成に伴うデータ消失そのものへの対策として、内部データをDocker Volumeに分離し、コンテナが再生成されてもAnsibleの投入データを生かす設計を扱います。

**[次回：第47回：ステートフルなデータ（Volume/DB）を保持しながらの安全な再構築](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)　｜　[次の記事：【Ansible×Terraform編】第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)**

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