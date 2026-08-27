---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第26回：管理者権限（sudo）実行時におけるパスワード入力のプロンプト停止'
description: 'Terraformのlocal-exec経由でAnsibleのbecomeを実行する構成において、パスワード入力を要求するオプションを指定した場合に、非対話実行環境ではプロンプトへの応答が成立せず処理が無応答のまま停止する条件を整理する。実機検証を交えて、停止が発生する条件と回避策をあわせて扱う。'
pubDate: '2026-08-26'
category: 'infra'
tags: ['Ansible', 'Terraform', 'sudo', 'become', 'IaC']
seriesId: 'ansible-terraform-part3'
seriesNo: 26
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/'
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
2. [becomeの認証方式とパスワード入力の要否](#2-becomeの認証方式とパスワード入力の要否)
3. [対話実行と非対話実行での標準入力の接続先の違い](#3-対話実行と非対話実行での標準入力の接続先の違い)
4. [local-exec経由での停止の現れ方](#4-local-exec経由での停止の現れ方)
5. [NOPASSWD設定による回避](#5-nopasswd設定による回避)
6. [Ansible Vaultによる非対話的なパスワード管理](#6-ansible-vaultによる非対話的なパスワード管理)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「`become: yes`を設定しておけば、sudo実行は自動で通る」と考えたことはないでしょうか。

**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)** では、実行前の静的解析における、HCLの構文チェックとansible-lintの競合を扱いました。**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** となる今回は、再び実行時の問題に戻ります。ただし、これまでの回とは現れ方が異なります。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** では、エラーは発生するものの、その原因箇所がログの中で見えにくいという問題を扱いました。今回扱うのは、そもそもエラーとして出力されないまま、処理が先に進まなくなるケースです。

Terraformの`local-exec`プロビジョナー経由でAnsibleの`become`を実行する構成では、特定の条件下で、sudoパスワードの入力を求めるプロンプトへの応答が成立せず、`terraform apply`自体が無応答のまま停止することがあります。この回では、どのような条件でこの停止が発生するのか、実機検証を交えて構造を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. becomeの認証方式とパスワード入力の要否

この回の前提となる、becomeの認証構造を確認します。`ansible_user`・`become`・`become_user`の関係については **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09/)** で整理していますので、ここでは本回で必要な範囲にとどめます。

Ansibleの`become`は、デフォルトで`sudo`を昇格手段として使います（`become_method: sudo`。この`sudo`が実際にパスワードを要求するかどうかは、Ansible側の設定ではなく、ターゲット側の`sudoers`の設定によって決まります。

```
become_method: sudo（デフォルト）
　↓
sudoersでNOPASSWDが設定されている
　→ パスワード入力なしで昇格できる
　↓
NOPASSWDが設定されていない
　→ sudoパスワードの入力が必要になる
```

NOPASSWDが設定されていないユーザーに対して`become`を実行すると、Ansibleはそのユーザーのsudoパスワードを必要とします。このパスワードをAnsibleにどう渡すか、あるいは渡さないかが、次のセクション以降で扱う問題の起点になります。

次のセクションでは、このパスワードの受け渡しに関わる、Ansible実行時のオプション指定と、実行環境の違いによる挙動を、実機検証で確認します。

---

[↑ 目次に戻る](#-目次)

---

## 3. 対話実行と非対話実行での標準入力の接続先の違い

セクション2で確認した通り、NOPASSWDが設定されていないユーザーに対して`become`を実行すると、Ansibleはsudoパスワードを必要とします。このパスワードをAnsibleにどう渡すかは、`--ask-become-pass`（`-K`）オプションの指定有無によって変わります。

まず、`--ask-become-pass`を指定しない場合の挙動を確認します。

### ■ 検証内容：--ask-become-passなしでの実行確認

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini ../ansible/playbooks/check_become.yml
```

**▼ 実行結果**

```plaintext
PLAY [target-node1] *************************************************************************************************************************************************************************
TASK [Gathering Facts] **********************************************************************************************************************************************************************
fatal: [target-node1]: FAILED! => {"msg": "Missing sudo password"}
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=0    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
```

`--ask-become-pass`を指定しない場合、プロンプトは表示されず、`Missing sudo password`というメッセージで即座に処理が終了します。

次に、`--ask-become-pass`を指定した場合の挙動を確認します。

### ■ 検証内容：--ask-become-passありでの実行確認

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini ../ansible/playbooks/check_become.yml --ask-become-pass
```

**▼ 実行結果**

```plaintext
BECOME password: 
PLAY [target-node1] *************************************************************************************************************************************************************************
TASK [Gathering Facts] **********************************************************************************************************************************************************************
fatal: [target-node1]: FAILED! => {"msg": "Missing sudo password"}
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=0    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
```

手元の端末（TTY）から直接実行した場合、`--ask-become-pass`を指定すると`BECOME password:`のプロンプトが表示されます。この端末は入力を受け付けられる状態にあるため、値を入力する（あるいは空のままEnterを押す）ことができ、その入力を踏まえてAnsibleが処理を継続します。

続けて、Terraformの`local-exec`経由での挙動を確認します。まず`--ask-become-pass`を指定しない場合です。

### ■ 検証内容：local-exec経由、--ask-become-passなしでの実行確認

**実行コマンド**

```plaintext
terraform apply -target=null_resource.check_become
```

**▼ 実行結果**

```plaintext
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
docker_network.app_net: Refreshing state... [id=54f7b73fd1625642a3ef6ed67fbde6f93062353422a9afeced223cd940c4c5ca]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_container.targets["target-node2"]: Refreshing state... [id=9371cd75cc4aea7f43e51ff39fbb18e599634d57fb90ce03ca65b21995327088]
docker_container.targets["target-node3"]: Refreshing state... [id=3ca0cbdc9df5ccd484b3573bdb539fb142c2e3248df2a2a4118053ebbb1f6192]
docker_container.targets["target-node1"]: Refreshing state... [id=37ec27743c93df681f66ac31b2f14507a35a55540dca7b4b340ec3a0b74d609d]
local_file.ansible_inventory: Refreshing state... [id=3ded465751ae7883faf871c4895d1c5d735723c3]

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # null_resource.check_become will be created
  + resource "null_resource" "check_become" {
      + id = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.
╷
│ Warning: Resource targeting is in effect
│
│ You are creating a plan with the -target option, which means that the result of this plan may not represent all of the changes requested by the current configuration.
│
│ The -target option is not for routine use, and is provided only for exceptional situations such as recovering from errors or mistakes, or when Terraform specifically suggests to use it
│ as part of an error message.
╵

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.check_become: Creating...
null_resource.check_become: Provisioning with 'local-exec'...
null_resource.check_become (local-exec): Executing: ["/bin/sh" "-c" "ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/check-become.log ansible-playbook -i inventory.ini ../ansible/playbooks/check_become.yml"]

null_resource.check_become (local-exec): PLAY [target-node1] ************************************************************

null_resource.check_become (local-exec): TASK [Gathering Facts] *********************************************************
null_resource.check_become (local-exec): fatal: [target-node1]: FAILED! => {"msg": "Missing sudo password"}

null_resource.check_become (local-exec): PLAY RECAP *********************************************************************
null_resource.check_become (local-exec): target-node1               : ok=0    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0

╷
│ Warning: Applied changes may be incomplete
│
│ The plan was created with the -target option in effect, so some changes requested in the configuration may have been ignored and the output values may not be fully updated. Run the
│ following command to verify that no other changes are pending:
│     terraform plan
│
│ Note that the -target option is not suitable for routine use, and is provided only for exceptional situations such as recovering from errors or mistakes, or when Terraform specifically
│ suggests to use it as part of an error message.
╵
╷
│ Error: local-exec provisioner error
│
│   with null_resource.check_become,
│   on main.tf line 127, in resource "null_resource" "check_become":
│  127:   provisioner "local-exec" {
│
│ Error running command 'ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/check-become.log ansible-playbook -i inventory.ini ../ansible/playbooks/check_become.yml': exit status 2. Output:
│ PLAY [target-node1] ************************************************************
│
│ TASK [Gathering Facts] *********************************************************
│ fatal: [target-node1]: FAILED! => {"msg": "Missing sudo password"}
│
│ PLAY RECAP *********************************************************************
│ target-node1               : ok=0    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
│
│
╵
```

`local-exec`経由であっても、`--ask-become-pass`を指定しない場合は、手元端末から直接実行した場合と同じく`Missing sudo password`で即座に失敗し、Terraform側も`local-exec provisioner error`という明確なエラーを出して`terraform apply`を終了します。

最後に、`local-exec`経由で`--ask-become-pass`を指定した場合の挙動を確認します。

### ■ 検証内容：local-exec経由、--ask-become-passありでの実行確認

**実行コマンド**

```plaintext
terraform apply -target=null_resource.check_become
```

**▼ 実行結果**

```plaintext
docker_network.app_net: Refreshing state... [id=54f7b73fd1625642a3ef6ed67fbde6f93062353422a9afeced223cd940c4c5ca]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
docker_container.targets["target-node1"]: Refreshing state... [id=37ec27743c93df681f66ac31b2f14507a35a55540dca7b4b340ec3a0b74d609d]
docker_container.targets["target-node2"]: Refreshing state... [id=9371cd75cc4aea7f43e51ff39fbb18e599634d57fb90ce03ca65b21995327088]
docker_container.targets["target-node3"]: Refreshing state... [id=3ca0cbdc9df5ccd484b3573bdb539fb142c2e3248df2a2a4118053ebbb1f6192]
local_file.ansible_inventory: Refreshing state... [id=3ded465751ae7883faf871c4895d1c5d735723c3]
null_resource.check_become: Refreshing state... [id=669761433530415789]

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # null_resource.check_become is tainted, so must be replaced
-/+ resource "null_resource" "check_become" {
      ~ id = "669761433530415789" -> (known after apply)
    }

Plan: 1 to add, 0 to change, 1 to destroy.
╷
│ Warning: Resource targeting is in effect
│
│ You are creating a plan with the -target option, which means that the result of this plan may not represent all of the changes requested by the current configuration.
│
│ The -target option is not for routine use, and is provided only for exceptional situations such as recovering from errors or mistakes, or when Terraform specifically suggests to use it
│ as part of an error message.
╵

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.check_become: Destroying... [id=669761433530415789]
null_resource.check_become: Destruction complete after 0s
null_resource.check_become: Creating...
null_resource.check_become: Provisioning with 'local-exec'...
null_resource.check_become (local-exec): Executing: ["/bin/sh" "-c" "ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/check-become.log ansible-playbook -i inventory.ini ../ansible/playbooks/check_become.yml --ask-become-pass"]
BECOME password: null_resource.check_become: Still creating... [00m10s elapsed]
null_resource.check_become: Still creating... [00m20s elapsed]
null_resource.check_become: Still creating... [00m30s elapsed]
null_resource.check_become: Still creating... [00m40s elapsed]
null_resource.check_become: Still creating... [00m50s elapsed]
null_resource.check_become: Still creating... [01m00s elapsed]
null_resource.check_become: Still creating... [01m10s elapsed]
null_resource.check_become: Still creating... [01m20s elapsed]
null_resource.check_become: Still creating... [01m30s elapsed]
null_resource.check_become: Still creating... [01m40s elapsed]
null_resource.check_become: Still creating... [01m50s elapsed]
null_resource.check_become: Still creating... [02m00s elapsed]
null_resource.check_become: Still creating... [02m10s elapsed]
null_resource.check_become: Still creating... [02m20s elapsed]
null_resource.check_become: Still creating... [02m30s elapsed]
null_resource.check_become: Still creating... [02m40s elapsed]
null_resource.check_become: Still creating... [02m50s elapsed]
null_resource.check_become: Still creating... [03m00s elapsed]
null_resource.check_become: Still creating... [03m10s elapsed]
null_resource.check_become: Still creating... [03m20s elapsed]
null_resource.check_become: Still creating... [03m30s elapsed]
null_resource.check_become: Still creating... [03m40s elapsed]
null_resource.check_become: Still creating... [03m50s elapsed]
null_resource.check_become: Still creating... [04m00s elapsed]
null_resource.check_become: Still creating... [04m10s elapsed]
null_resource.check_become: Still creating... [04m20s elapsed]
null_resource.check_become: Still creating... [04m30s elapsed]
null_resource.check_become: Still creating... [04m40s elapsed]
null_resource.check_become: Still creating... [04m50s elapsed]
null_resource.check_become: Still creating... [05m00s elapsed]
null_resource.check_become: Still creating... [05m10s elapsed]
null_resource.check_become: Still creating... [05m20s elapsed]
null_resource.check_become: Still creating... [05m30s elapsed]
null_resource.check_become: Still creating... [05m40s elapsed]
null_resource.check_become: Still creating... [05m50s elapsed]
null_resource.check_become: Still creating... [06m00s elapsed]
null_resource.check_become: Still creating... [06m10s elapsed]
null_resource.check_become: Still creating... [06m20s elapsed]
null_resource.check_become: Still creating... [06m30s elapsed]
null_resource.check_become: Still creating... [06m40s elapsed]
null_resource.check_become: Still creating... [06m50s elapsed]
null_resource.check_become: Still creating... [07m00s elapsed]

Interrupt received.
Please wait for Terraform to exit or data loss may occur.
Gracefully shutting down...

Stopping operation...
null_resource.check_become (local-exec):  [ERROR]: User interrupted execution
╷
│ Warning: Applied changes may be incomplete
│
│ The plan was created with the -target option in effect, so some changes requested in the configuration may have been ignored and the output values may not be fully updated. Run the
│ following command to verify that no other changes are pending:
│     terraform plan
│
│ Note that the -target option is not suitable for routine use, and is provided only for exceptional situations such as recovering from errors or mistakes, or when Terraform specifically
│ suggests to use it as part of an error message.
╵
╷
│ Error: execution halted
│
│
╵
╷
│ Error: execution halted
│
│
╵
╷
│ Error: local-exec provisioner error
│
│   with null_resource.check_become,
│   on main.tf line 127, in resource "null_resource" "check_become":
│  127:   provisioner "local-exec" {
│
│ Error running command 'ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/check-become.log ansible-playbook -i inventory.ini ../ansible/playbooks/check_become.yml --ask-become-pass': signal:
│ killed. Output:  [ERROR]: User interrupted execution
│
╵
```

`--ask-become-pass`を指定した状態で`local-exec`経由で実行すると、`BECOME password:`のプロンプトはログ上に出力されるものの、`Still creating...`の表示が10秒間隔で延々と続き、処理が先に進みません。今回の検証では7分以上経過しても変化がなかったため、`Ctrl+C`によって手動で処理を中断しました。中断後は`Interrupt received.`に続き、最終的に`local-exec provisioner error`(`signal: killed`)としてエラーが記録されています。

### ■ 結果

ここまでの4パターンの検証結果を整理します。

|実行方法|`--ask-become-pass`|結果|
|---|---|---|
|手元端末から直接|なし|即座に`Missing sudo password`|
|手元端末から直接|あり|プロンプト表示、入力後に即座に`Missing sudo password`|
|`local-exec`経由|なし|即座に`local-exec provisioner error`(`exit status 2`)|
|`local-exec`経由|あり|プロンプト表示、応答できず無応答が継続、`Ctrl+C`でのみ終了|

対話実行と非対話実行の違いそのものが停止の原因ではなく、`--ask-become-pass`によってプロンプトへの応答を要求した状態で、その応答先が用意されていない場合にのみ、処理が無応答のまま続くことが分かります。手元端末からの直接実行では、プロンプトに対してユーザー自身が入力できるため無応答にはなりませんが、`local-exec`経由の場合はこの入力先が存在しないため、無応答のまま停止します。

---

[↑ 目次に戻る](#-目次)

---

## 4. local-exec経由での停止の現れ方

セクション3で確認した通り、`--ask-become-pass`を指定した状態で`local-exec`経由の実行を行うと、`terraform apply`は無応答のまま停止し続けます。このセクションでは、この停止が持つ特有の症状を整理します。

### ■ 検証内容：無応答中のプロセスツリーの確認

セクション3の無応答状態が続いている間、別のターミナルからコントロールノード上のプロセス状況を確認します。

**実行コマンド**

```plaintext
ps aux | grep ansible
```

**▼ 実行結果**

```plaintext
control     3729  0.0  0.0   2892   960 pts/0    S+   06:40   0:00 /bin/sh -c ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/check-become.log ansible-playbook -i inventory.ini ../ansible/playbooks/check_become.yml --ask-become-pass
control     3730  0.2  1.8  52960 37448 pts/0    S+   06:40   0:01 /home/control/ansible-env/bin/python3 /home/control/ansible-env/bin/ansible-playbook -i inventory.ini ../ansible/playbooks/check_become.yml --ask-become-pass
control     3841  0.0  0.1   6612  2404 pts/1    S+   06:46   0:00 grep --color=auto ansible
```

`local-exec`が起動したシェル（PID 3729）の配下に、`ansible-playbook`プロセス（PID 3730）がそのまま残っていることが確認できます。ステータスは`S+`（フォアグラウンドで割り込み可能なスリープ状態）であり、`06:40`の開始時刻から`06:46`時点でも終了していません。`ansible-playbook`自体がBECOMEパスワードのプロンプト入力待ちで停止しており、`local-exec`はこの子プロセスの終了を待ち続けているため、`terraform apply`全体が先に進まない構造になっています。

### ■ 結果

セクション3・4の検証結果を踏まえ、この停止が持つ特有の症状を整理します。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** で扱った問題は、エラー自体は発生し出力されるものの、Terraformのログとansible-playbookのログにネストされる形で出力されるため、原因箇所が見えにくいというものでした。今回の停止は、これとは性質が異なります。

```
第21回の問題：エラーは発生し出力されるが、原因箇所が見えにくい
第26回の問題：エラー自体が発生せず、無応答のまま処理が停止する（ただし、この現象は--ask-become-passを指定した場合に限られる）
```

エラーメッセージが一切出力されないため、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** で有効だった、Terraform側の`exit status`やエラーログを起点にした原因追跡の手法は、この停止に対しては機能しません。停止中に手がかりを得るには、セクション3・4で確認したように、`ps`コマンドでプロセスツリーを直接確認し、`ansible-playbook`がプロンプト入力待ちのまま残っていることを確かめる必要があります。

なお、この停止は`--ask-become-pass`を指定した場合に限られ、指定しない場合は`local-exec`経由であっても速やかにエラーとして出力されることは、セクション3で確認した通りです。次のセクションでは、この停止をそもそも発生させないための回避策として、NOPASSWD設定による方法を扱います。

---

[↑ 目次に戻る](#-目次)

---

## 5. NOPASSWD設定による回避

セクション3・4で確認した停止は、`--ask-become-pass`を指定した状態で、パスワードが要求されるユーザーに対して`become`を実行した場合に発生していました。このセクションでは、visudo等でNOPASSWDを設定し、パスワード入力そのものを不要にすることで、この停止を回避できることを確認します。

### ■ 検証内容：NOPASSWD設定済みの状態での実行確認

target-node1の`ansible`ユーザーに、以下の設定がsudoers側に存在する状態にします。

```
ansible ALL=(ALL) NOPASSWD:ALL
```

この設定がある状態で、`--ask-become-pass`を指定しない構成の`check_become.yml`を`local-exec`経由で実行します。

**実行コマンド**

```plaintext
terraform apply -target=null_resource.check_become -replace=null_resource.check_become
```

**▼ 実行結果**

```plaintext
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_network.app_net: Refreshing state... [id=54f7b73fd1625642a3ef6ed67fbde6f93062353422a9afeced223cd940c4c5ca]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
docker_container.targets["target-node1"]: Refreshing state... [id=37ec27743c93df681f66ac31b2f14507a35a55540dca7b4b340ec3a0b74d609d]
docker_container.targets["target-node2"]: Refreshing state... [id=9371cd75cc4aea7f43e51ff39fbb18e599634d57fb90ce03ca65b21995327088]
docker_container.targets["target-node3"]: Refreshing state... [id=3ca0cbdc9df5ccd484b3573bdb539fb142c2e3248df2a2a4118053ebbb1f6192]
local_file.ansible_inventory: Refreshing state... [id=3ded465751ae7883faf871c4895d1c5d735723c3]
null_resource.check_become: Refreshing state... [id=643296422756563136]

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # null_resource.check_become will be replaced, as requested
-/+ resource "null_resource" "check_become" {
      ~ id = "643296422756563136" -> (known after apply)
    }

Plan: 1 to add, 0 to change, 1 to destroy.
╷
│ Warning: Resource targeting is in effect
│
│ You are creating a plan with the -target option, which means that the result of this plan may not represent all of the changes requested by the current configuration.
│
│ The -target option is not for routine use, and is provided only for exceptional situations such as recovering from errors or mistakes, or when Terraform specifically suggests to use it
│ as part of an error message.
╵

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.check_become: Destroying... [id=643296422756563136]
null_resource.check_become: Destruction complete after 0s
null_resource.check_become: Creating...
null_resource.check_become: Provisioning with 'local-exec'...
null_resource.check_become (local-exec): Executing: ["/bin/sh" "-c" "ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/check-become.log ansible-playbook -i inventory.ini ../ansible/playbooks/check_become.yml"]

null_resource.check_become (local-exec): PLAY [target-node1] ************************************************************

null_resource.check_become (local-exec): TASK [Gathering Facts] *********************************************************
null_resource.check_become (local-exec): [WARNING]: Platform linux on host target-node1 is using the discovered Python
null_resource.check_become (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.check_become (local-exec): interpreter could change the meaning of that path. See
null_resource.check_become (local-exec): https://docs.ansible.com/ansible-
null_resource.check_become (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.check_become (local-exec): ok: [target-node1]

null_resource.check_become (local-exec): TASK [whoamiを確認する] ********************************************************
null_resource.check_become (local-exec): changed: [target-node1]

null_resource.check_become (local-exec): PLAY RECAP *********************************************************************
null_resource.check_become (local-exec): target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

null_resource.check_become: Creation complete after 9s [id=2066511241251379461]
╷
│ Warning: Applied changes may be incomplete
│
│ The plan was created with the -target option in effect, so some changes requested in the configuration may have been ignored and the output values may not be fully updated. Run the
│ following command to verify that no other changes are pending:
│     terraform plan
│
│ Note that the -target option is not suitable for routine use, and is provided only for exceptional situations such as recovering from errors or mistakes, or when Terraform specifically
│ suggests to use it as part of an error message.
╵

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.18.0.2"
  "target-node2" = "172.20.0.2"
  "target-node3" = "172.20.0.3"
}
```

### ■ 結果

NOPASSWDが設定されたユーザーに対して`become`を実行すると、プロンプトの表示自体がなく、9秒で処理が完了しました。セクション3・4で確認した無応答は発生していません。

セクション3・4の停止は、パスワードの入力が求められる状態にもかかわらず、その入力先が用意されていないことが原因でした。NOPASSWDを設定しておけば、そもそもパスワードの入力自体が不要になるため、`local-exec`のような非対話実行の環境でも、この停止は発生しなくなります。

visudo等でNOPASSWDを設定する場合、以下のような記述になります。

```
# /etc/sudoers.d/ansible 設定例（コンテナ内のansibleユーザーに対して設定）
ansible ALL=(ALL) NOPASSWD: ALL
```

この設定には、誰にどの権限を与えるかというセキュリティ上の考慮が伴いますが、その設計判断自体は本回の対象外とします。ここでは、非対話実行を前提とする構成において、NOPASSWD設定が停止を回避する手段になるという位置づけで示します。ベースイメージ側にこの設定を組み込んでおけば、コンテナ再生成のたびに設定し直す手間も避けられます。

なお、NOPASSWDが設定されているユーザーに対して`ansible_user`・`become`・`become_user`を正しく指定する方法自体は、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09/)** で扱っています。**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-09/)** では、コンテナごとに異なるデフォルトユーザーに対してNOPASSWD設定をTerraformのプロビジョニングで行う方法を扱いましたが、そこで示した設定パターン自体は、今回のようにTerraformの`local-exec`から直接Ansibleを実行する構成でも同様に有効です。

---

[↑ 目次に戻る](#-目次)

---

## 6. Ansible Vaultによる非対話的なパスワード管理

セクション5では、NOPASSWD設定によってパスワード入力自体を不要にする方法を確認しました。しかし、運用上の制約からNOPASSWDを設定できない場合もあります。このセクションでは、そうした場合の代替手段として、Ansible Vaultを使ってsudoパスワードを非対話的に渡す方法を整理します。

NOPASSWDを設定しない場合、`become`実行時にはパスワードそのものが必要になります。このパスワードを、セクション3で確認したような対話的なプロンプト（`--ask-become-pass`)に頼らず、あらかじめ暗号化した状態でAnsibleに渡せれば、`local-exec`のような非対話実行の環境でも、プロンプトへの応答を待たずに`become`を完了できます。この役割を担うのがAnsible Vaultです。

まず、sudoパスワードを暗号化した変数として保持します。

```
ansible-vault encrypt_string 'sudo_pass_value' --name 'ansible_become_pass'
```

このコマンドは、`sudo_pass_value`という平文の値を暗号化し、`ansible_become_pass`という変数名で出力します。出力された暗号化済みの文字列を、`group_vars`等に配置します。

```yaml
ansible_become_pass: !vault |
          $ANSIBLE_VAULT;1.1;AES256
          6162636465666768696a6b6c6d6e6f70...
```

`ansible_become_pass`は、Ansibleが`become`実行時にパスワードとして参照する予約変数です。この変数がVaultで暗号化された状態で用意されていれば、Ansibleは`--ask-become-pass`のようなプロンプトを介さずに、このパスワードを直接使って`become`を試みます。

ただし、暗号化された変数を復号するための鍵（Vaultパスワード）自体は、別途Ansibleに渡す必要があります。この受け渡しには`--vault-password-file`オプションを使います。

```
ansible-playbook -i inventory.ini playbook.yml --vault-password-file .vault_pass
```

`.vault_pass`には、Vaultの復号キーとなる文字列を平文で記載しておきます。このファイル自体の権限管理（第三者に読み取られないようにする）は必要になりますが、実行時にはこのファイルを参照するだけで復号が完了するため、対話的な入力は発生しません。

この構成をTerraformの`local-exec`に組み込む場合、`command`に`--vault-password-file`のオプションを追加する形になります。

```hcl
resource "null_resource" "check_become" {
  depends_on = [local_file.ansible_inventory]
  provisioner "local-exec" {
    command = "ANSIBLE_SSH_RETRIES=0 ansible-playbook -i inventory.ini ../ansible/playbooks/check_become.yml --vault-password-file .vault_pass"
  }
}
```

セクション5のNOPASSWD設定が「パスワードの入力自体を不要にする」方法だったのに対し、この方法は「パスワードは必要なままだが、その受け渡しをファイル経由で非対話的に行う」方法です。ターゲット側にNOPASSWDを設定できない事情がある場合、あるいはパスワードそのものを何らかの形で管理下に置いておきたい場合には、こちらの方法が選択肢になります。

なお、TerraformとAnsible Vaultの役割分担については、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** で、機密情報をどちらのツールで管理すべきかという観点から整理しています。sudoパスワードのような機密情報をAnsible Vault側で一元管理するという方針は、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** で示した役割分担とも一致します。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* Terraformの`local-exec`経由でAnsibleの`become`を実行する場合、対話実行と非対話実行の違いそのものが停止の原因ではなく、`--ask-become-pass`のようなパスワード入力を要求するオプションを指定した状態で、その応答先が用意されていない場合にのみ、処理が無応答のまま停止する
* この停止は、`local-exec`が起動した`ansible-playbook`の子プロセスがBECOMEパスワードのプロンプト入力待ちのまま残り続け、`local-exec`側もこの子プロセスの終了を待ち続けることで発生する。エラーメッセージは一切出力されないため、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** のようなログ解析の手法は機能しない
* 停止中は`ps`コマンドでプロセスツリーを確認することで、`ansible-playbook`がプロンプト入力待ちのまま残っていることを確かめられる
* 回避策として、NOPASSWDをsudoers側に設定し、パスワード入力自体を不要にする方法がある。この方法は実機検証でも有効性を確認しており、プロンプトの表示自体がなくなり、`local-exec`経由でも無人のまま正常に完了する
* NOPASSWDを設定できない事情がある場合は、Ansible Vaultでsudoパスワードを暗号化し、`--vault-password-file`で復号キーを渡すことで、対話的なプロンプトに頼らずに`become`を完了させる方法がある

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)** では、HCL構文チェックとansible-lintという、静的解析ツール同士のルールが競合する問題を扱いました。**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** となる今回は、実行前の静的解析から再び実行時の問題に戻り、Terraformの`local-exec`経由でAnsibleの`become`を実行する構成における、非対話実行時の停止を扱いました。エラーとして出力されないまま処理が無応答になる、というこれまでの回とは異なる現れ方を、実機検証を交えて確認しました。

次回は、認証時の対話待ちによる停止から離れ、Ansibleでカーネル更新等のためにOS再起動を要求した際に、接続が途切れTerraformがエラー扱いしてしまう問題を扱います。

**[次回：第27回：再起動、再生成に伴うプロビジョニング断絶](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)　｜　[次の記事：【Ansible×Terraform編】第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**

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
|**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**|管理者権限（sudo）実行時におけるパスワード入力のプロンプト停止|Terraformのlocal-exec経由でAnsibleのbecomeを実行する際、パスワード入力を要求するオプションを指定した場合に限り、非対話実行環境で処理が無応答のまま停止する問題。|
|**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**|再起動、再生成に伴うプロビジョニング断絶|AnsibleのrebootモジュールによるOS再起動時、接続断絶が正常な過程か異常な停止かをTerraformのlocal-execが区別できず、外側のタイムアウトと競合する問題。|
|**[第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)**|異種OS（Windowsターゲット）混在環境における接続プロトコルの制約|SSHではなくWinRM等を用いる特殊プロトコル環境での接続、権限エラー。実務でWindows ServerをAnsible×Terraformで管理する際の構造的注意点を扱う概念解説回。|
|**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)**|プロキシ環境等における外部コレクション（Ansible Galaxy）の取得失敗|インフラ構築処理の途中で外部ネットワーク（Ansible Galaxy等）への依存が切れ、Terraformの処理全体が失敗する問題。|
|**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)**|デバッグフラグの組み合わせによるログ解析の高度化|Terraformの`TF_LOG`とAnsibleの`-vvvv`を組み合わせ、接続遅延や処理遅延のボトルネックを特定、解消する手法。|

---

[↑ 目次に戻る](#-目次)

---