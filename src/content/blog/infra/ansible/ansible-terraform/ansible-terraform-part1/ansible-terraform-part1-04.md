---
title: "「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第4回：自動生成されたSSH鍵のパーミッション設定エラー"
description: "Terraformが自動生成した秘密鍵ファイルのパーミッションがSSHクライアントの要件を満たさない場合に接続が拒否される構造と、正しいパーミッション設定の構成を解説します。"
pubDate: 2026-08-14
category: "Infrastructure"
tags: ["Ansible", "Terraform", "SSH", "Docker", "IaC", 'infra']
seriesId: 'ansible-terraform-part1'
seriesNo: 4
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-03/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-05/'
relatedSeries: ""
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
2. [Terraformが出力する秘密鍵ファイルのパーミッション](#2-terraformが出力する秘密鍵ファイルのパーミッション)
3. [SSHクライアントによるパーミッション検査](#3-sshクライアントによるパーミッション検査)
4. [接続拒否エラーの再現](#4-接続拒否エラーの再現)
5. [file_permission属性による解決](#5-file_permission属性による解決)
6. [chmodによる代替構成](#6-chmodによる代替構成)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

## 1. はじめに

**[前回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-03/)** 、TerraformのJSON出力をAnsibleが動的インベントリとして認識できるようにしました。接続先の情報が正しく渡るようになった状態で次に直面するのが、SSH接続そのものが拒否されるというトラブルです。

Terraformで構築した環境にAnsibleで接続しようとした際、以下のようなエラーに遭遇することがあります。

```plaintext
Permissions 0775 for '...' are too open.
It is required that your private key files are NOT accessible by others.
```

鍵ファイルは確かに存在しており、内容も正しいはずなのに、SSHクライアントが接続そのものを拒否してしまう状態です。この現象は、TerraformのAWS・GCP・オンプレミスなど、プロバイダーの種類を問わず、秘密鍵ファイルをローカルに出力する構成であれば共通して発生します。

今回は、この「鍵はあるのに繋がらない」という状況がなぜ起きるのか、その構造を整理します。

---

[↑ 目次に戻る](#目次)

---

## 2. Terraformが出力する秘密鍵ファイルのパーミッション

Terraformの`tls_private_key`リソースで生成した秘密鍵を、`local_file`リソースでローカルに出力した場合、何もオプションを指定しなければどのようなパーミッションになるかを確認します。

* **ファイル名：`main.tf`（抜粋）**

```hcl
resource "tls_private_key" "generated" {
  algorithm = "ED25519"
}

resource "local_file" "private_key" {
  filename = "${path.module}/id_ed25519_generated"
  content  = tls_private_key.generated.private_key_openssh
}
```

`tls_private_key`リソースで鍵ペアを生成し、`local_file`リソースの`content`にそのまま秘密鍵の内容を渡してファイルへ出力しています。この時点では、パーミッションに関するオプションは何も指定していません。

`terraform apply`を実行した後、出力されたファイルのパーミッションを確認します。

* **実行コマンド**：`ls -l id_ed25519_generated`
* **実行結果**：
```plaintext
-rwxrwxr-x 1 control control 387 Aug 14 09:59 id_ed25519_generated
```

パーミッションは`0775`でした。所有者だけでなく、同じグループに属するユーザーからも書き込みが可能な状態です。

このデフォルト値は、`local_file`リソース自体が固定で持っている値ではなく、Terraformを実行しているOS側の`umask`設定に依存します。SSHクライアントが要求する`0600`より緩い状態でファイルが出力される、という点がここでの要点です。

---

[↑ 目次に戻る](#目次)

---

## 3. SSHクライアントによるパーミッション検査

SSHクライアントが秘密鍵ファイルのパーミッションを検査する仕組みを整理します。

SSHクライアントは、秘密鍵ファイルのパーミッションが`0600`より緩い場合、その鍵の使用自体を拒否します。これは「自分以外のユーザーが読み取れる状態の秘密鍵は、安全な鍵として扱わない」というSSHクライアント側の設計によるものです。秘密鍵はその名の通り、所有者本人だけがアクセスできる状態であることが前提であり、同じグループやその他のユーザーが読み書きできる状態のファイルは、たとえ内容が正しくても信頼できないと判断されます。

このチェックは秘密鍵ファイルそのものに対してのみ行われます。公開鍵ファイル（`.pub`）や、`authorized_keys`ファイルのパーミッションは、この検査の対象ではありません。

パーミッションと、SSHクライアントの判定の対応を整理すると以下のようになります。

|パーミッション|SSHクライアントの判定|
|---|---|
|0600|接続を許可する|
|0644|接続を拒否する|
|0775|接続を拒否する|

`0600`は「所有者のみ読み書き可能」という意味です。グループやその他のユーザーへの権限が一切付与されていない状態が、SSHクライアントの求める最低条件になります。

---

[↑ 目次に戻る](#目次)

---


## 4. 接続拒否エラーの再現

前のセクションで確認したデフォルトパーミッション（`0775`）のまま、Ansibleからこの鍵を使ってSSH接続を試みます。

* **実行コマンド**：`ansible all -i inventory.ini -m ping --private-key=./id_ed25519_generated`
* **実行結果**：
```
target-node2 | UNREACHABLE! => {  
"changed": false,  
"msg": "Failed to connect to the host via ssh: @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@ WARNING: UNPROTECTED PRIVATE KEY FILE! @\r\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\nPermissions 0775 for '/home/control/iac/docker-lab/id_ed25519_generated' are too open.\r\nIt is required that your private key files are NOT accessible by others.\r\nThis private key will be ignored.\r\nLoad key "/home/control/iac/docker-lab/id_ed25519_generated": bad permissions\r\nansible@172.18.0.2: Permission denied (publickey,password).",  
"unreachable": true  
}  
target-node3 | UNREACHABLE! => {  
"changed": false,  
"msg": "Failed to connect to the host via ssh: @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@ WARNING: UNPROTECTED PRIVATE KEY FILE! @\r\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\nPermissions 0775 for '/home/control/iac/docker-lab/id_ed25519_generated' are too open.\r\nIt is required that your private key files are NOT accessible by others.\r\nThis private key will be ignored.\r\nLoad key "/home/control/iac/docker-lab/id_ed25519_generated": bad permissions\r\nansible@172.18.0.3: Permission denied (publickey,password).",  
"unreachable": true  
}  
target-node1 | UNREACHABLE! => {  
"changed": false,  
"msg": "Failed to connect to the host via ssh: @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@ WARNING: UNPROTECTED PRIVATE KEY FILE! @\r\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\nPermissions 0775 for '/home/control/iac/docker-lab/id_ed25519_generated' are too open.\r\nIt is required that your private key files are NOT accessible by others.\r\nThis private key will be ignored.\r\nLoad key "/home/control/iac/docker-lab/id_ed25519_generated": bad permissions\r\nansible@172.18.0.4: Permission denied (publickey,password).",  
"unreachable": true  
}

```

3ノードすべてで`UNREACHABLE`となり、接続が拒否されました。

エラーメッセージを順に見ていきます。まず`WARNING: UNPROTECTED PRIVATE KEY FILE!`という警告ブロックが表示され、続けて`Permissions 0775 for '...' are too open.`という行で、実際のパーミッション値とともに「開きすぎている」ことが示されています。`This private key will be ignored.`はSSHクライアントがこの鍵の使用自体を拒否したことを意味し、最終的に`Load key "...": bad permissions`という形でエラーの原因が明記されています。Ansible側はこれを受けて`Permission denied (publickey,password).`という認証失敗のメッセージとともに、対象ホストを`UNREACHABLE`として報告しています。

エラーログの中から原因を特定する際は、`bad permissions`という文言、またはパーミッション値を明示した`are too open.`という行を探すのが最も確実です。同じ`Permission denied`でも、鍵の内容自体が誤っている場合や`authorized_keys`側の設定に問題がある場合は、この`bad permissions`という表記は現れません。

---

[↑ 目次に戻る](#目次)

---

## 5. file_permission属性による解決

`local_file`リソースには、出力するファイルのパーミッションを指定する`file_permission`属性があります。この属性を使い、秘密鍵のパーミッションを`0600`に設定します。

* **ファイル名：`main.tf`（`local_file.private_key`への追記）**

```hcl
resource "local_file" "private_key" {
  filename        = "${path.module}/id_ed25519_generated"
  content         = tls_private_key.generated.private_key_openssh
  file_permission = "0600"
}
```

`file_permission`属性に文字列で`"0600"`を指定しています。既存の`local_file.private_key`リソースに、この属性を1行追加しただけの変更です。

`terraform apply`を実行すると、`local_file.private_key`が再作成対象として計画に表示されます。

※ログが長いので、`file_permission`に関わる部分と結果部分のみ抜粋します。

```
# local_file.private_key must be replaced

-/+ resource "local_file" "private_key" {  
~ content_base64sha256 = "qPHRdk+dJYPEXyc6Qisy5AjklWcmkb0lin2V6ecYQF0=" -> (known after apply)  
~ content_base64sha512 = "6Na7OPOhYW/ZU9DhqA/Cgf9wd728syenFzNDfBfdYYmCjxPKq9I/xgzTw5Sd2BO9+RjKXB7AAW7cCJy/++Dvxw==" -> (known after apply)  
~ content_md5 = "05d13268fbf0be6aa7ea8425b7e7bd52" -> (known after apply)  
~ content_sha1 = "7d11d7745c28bb12f23b6501732973a67553e3e1" -> (known after apply)  
~ content_sha256 = "a8f1d1764f9d2583c45f273a422b32e408e495672691bd258a7d95e9e718405d" -> (known after apply)  
~ content_sha512 = "e8d6bb38f3a1616fd953d0e1a80fc281ff7077bdbcb327a71733437c17dd6189828f13caabd23fc60cd3c3949dd813bdf918ca5c1ec0016edc089cbffbe0efc7" -> (known after apply)  
~ file_permission = "0777" -> "0600" # forces replacement  
~ id = "7d11d7745c28bb12f23b6501732973a67553e3e1" -> (known after apply)  
# (3 unchanged attributes hidden)  
}

Plan: 5 to add, 0 to change, 5 to destroy.
```

`file_permission = "0777" -> "0600" # forces replacement`という行が示す通り、この属性の変更は既存ファイルの単純な上書きではなく、`local_file.private_key`の破棄と再作成という扱いになります。

この`local_file.private_key`の変更をきっかけに、`docker_container.targets`側の3ノードも再作成対象になります。ただしこちらは`file_permission`とは無関係で、`network_mode = "bridge" -> null # forces replacement`という別の差分（Dockerプロバイダー側の記録との不一致）が原因です。

```
Apply complete! Resources: 5 added, 0 changed, 5 destroyed.

Outputs:

target_nodes_ips = {  
"target-node1" = "172.18.0.2"  
"target-node2" = "172.18.0.4"  
"target-node3" = "172.18.0.3"  
}
```

`apply`が完了し、3ノードとも新しいIPアドレスで再作成されました。`inventory.ini`もこの新しいIPアドレスに合わせて自動的に再生成されているため、後続のAnsible実行には影響しません。

パーミッションを確認します。

* **実行コマンド**：`ls -l id_ed25519_generated`
* **実行結果**：
```
-rw------- 1 control control 387 Aug 14 10:28 id_ed25519_generated
```

パーミッションが`0600`になりました。所有者以外の読み書き権限がすべて外れ、SSHクライアントの要件を満たす状態です。

この状態で、改めてAnsibleからSSH接続を試みます。

* **実行コマンド**：`ansible all -i inventory.ini -m ping --private-key=./id_ed25519_generated`
* **実行結果**：
```

[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the  
meaning of that path. See [https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html](https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html) for more information.  
target-node1 | SUCCESS => {  
"ansible_facts": {  
"discovered_interpreter_python": "/usr/bin/python3.10"  
},  
"changed": false,  
"ping": "pong"  
}  
[WARNING]: Platform linux on host target-node2 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the  
meaning of that path. See [https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html](https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html) for more information.  
target-node2 | SUCCESS => {  
"ansible_facts": {  
"discovered_interpreter_python": "/usr/bin/python3.10"  
},  
"changed": false,  
"ping": "pong"  
}  
[WARNING]: Platform linux on host target-node3 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the  
meaning of that path. See [https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html](https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html) for more information.  
target-node3 | SUCCESS => {  
"ansible_facts": {  
"discovered_interpreter_python": "/usr/bin/python3.10"  
},  
"changed": false,  
"ping": "pong"  
}

```

3ノードすべてで`"ping": "pong"`が返り、接続が成功しました。`[WARNING]`はPythonインタープリタの検出に関する定型メッセージで、パーミッションとは無関係です。

`local_file`リソースで秘密鍵を出力する場合、`file_permission`属性を明示的に指定するだけで、この問題は解決します。


---

[↑ 目次に戻る](#目次)

---

## 6. chmodによる代替構成

`file_permission`属性が使えない場合の代替として、`null_resource`と`local-exec`プロビジョナーで`chmod`コマンドを実行する構成を確認します。

* **ファイル名：`main.tf`（`local_file.private_key`から`file_permission`を削除し、`null_resource`を追加）**

```hcl
resource "local_file" "private_key" {
  filename = "${path.module}/id_ed25519_generated"
  content  = tls_private_key.generated.private_key_openssh
}

resource "null_resource" "fix_permission" {
  provisioner "local-exec" {
    command = "chmod 0600 ${path.module}/id_ed25519_generated"
  }

  depends_on = [local_file.private_key]
}
```

`local_file.private_key`からは`file_permission`属性を外し、代わりに`null_resource.fix_permission`を追加しています。`depends_on`で`local_file.private_key`への依存を明示しており、秘密鍵ファイルが出力された後に`chmod`が実行される順序を保証しています。

`terraform apply`を実行します。

* **実行コマンド**：`terraform apply`
* **実行結果（※ログが長いため、途中を省略しています）**：
```

# null_resource.fix_permission will be created

+ resource "null_resource" "fix_permission" {
    + id = (known after apply)  
        }

Plan: 6 to add, 0 to change, 5 to destroy.

（…途中省略…）

null_resource.fix_permission: Creating...  
null_resource.fix_permission: Provisioning with 'local-exec'...  
null_resource.fix_permission (local-exec): Executing: ["/bin/sh" "-c" "chmod 0600 ./id_ed25519_generated"]  
null_resource.fix_permission: Creation complete after 0s [id=4436755063213838558]

（…途中省略…）

Apply complete! Resources: 6 added, 0 changed, 5 destroyed.

```

`null_resource.fix_permission`が実行され、`chmod 0600 ./id_ed25519_generated`が実際に発行されていることがログから確認できます。

パーミッションを確認します。

* **実行コマンド**：`ls -l id_ed25519_generated`
* **実行結果**：
```
-rw------- 1 control control 387 Aug 14 11:56 id_ed25519_generated
```

パーミッションは`0600`です。`file_permission`属性を使った場合と同じ結果が、`chmod`の実行によって得られています。

この状態でAnsibleからの接続を確認します。

* **実行コマンド**：`ansible all -i inventory.ini -m ping --private-key=./id_ed25519_generated`
* **実行結果**：
```
[WARNING]: Platform linux on host target-node2 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the  
meaning of that path. See [https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html](https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html) for more information.  
target-node2 | SUCCESS => {  
"ansible_facts": {  
"discovered_interpreter_python": "/usr/bin/python3.10"  
},  
"changed": false,  
"ping": "pong"  
}  
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the  
meaning of that path. See [https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html](https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html) for more information.  
target-node1 | SUCCESS => {  
"ansible_facts": {  
"discovered_interpreter_python": "/usr/bin/python3.10"  
},  
"changed": false,  
"ping": "pong"  
}  
[WARNING]: Platform linux on host target-node3 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the  
meaning of that path. See [https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html](https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html) for more information.  
target-node3 | SUCCESS => {  
"ansible_facts": {  
"discovered_interpreter_python": "/usr/bin/python3.10"  
},  
"changed": false,  
"ping": "pong"  
}
```

3ノードすべてで`"ping": "pong"`が返り、接続に成功しました。

5節の`file_permission`属性と、この節の`chmod`実行は、最終的なパーミッションとしては同じ`0600`に到達しますが、実現の方法が異なります。使い分けの目安を以下に整理します。

| 手法                    | 向いている場面                   |
| --------------------- | ------------------------- |
| file_permission属性     | local_fileリソースで出力する場合（推奨） |
| null_resource + chmod | 外部スクリプトや他の手段で鍵ファイルを出力する場合 |

`local_file`リソースで鍵を出力しているのであれば、`file_permission`属性の方がコードの見通しがよく、依存関係を意識する必要もありません。`null_resource`＋`chmod`は、`local_file`を使わない別の手段（外部スクリプトなど）で鍵ファイルが出力される場合の代替手段として位置づけられます。

---

[↑ 目次に戻る](#目次)

---

## 7. まとめ

今回は、Terraformが自動生成した秘密鍵ファイルのパーミッション不備によって、AnsibleのSSH接続が拒否される問題を扱いました。

- `local_file`リソースで秘密鍵を出力する場合、パーミッションを明示的に指定しなければ、実行環境の`umask`に依存した緩いパーミッション（今回の検証環境では`0775`）でファイルが出力される。この状態はSSHクライアントの要件（`0600`）を満たさず、接続が拒否される。この問題はDocker・VM・クラウドを問わず、Terraformが秘密鍵をローカルに出力する構成であれば共通して発生する
- エラーログに含まれる`WARNING: UNPROTECTED PRIVATE KEY FILE!`という警告と、`bad permissions`という記述が、パーミッション不備が原因であることを示す手がかりになる
- 解決策として、`local_file`リソースの`file_permission`属性で直接パーミッションを指定する方法と、`null_resource`＋`local-exec`で`chmod`を実行する方法の2通りがある。`local_file`で鍵を出力している場合は`file_permission`属性を使うのが基本であり、`chmod`による方法は`local_file`を使わない手段で鍵を出力する場合の代替として位置づけられる

---

[↑ 目次に戻る](#目次)

---

## 8. 次回予告

SSH鍵のパーミッション問題が解決した後、次に直面するのは別の種類の問題です。今回の検証でも、`terraform apply`のたびにコンテナが再作成され、内部IPアドレスが変わる場面が何度もありました。Terraformの管理するリソースが再作成されると、Ansibleの接続先として記録していたIPアドレスが古いままになり、意図しないホストへ接続しようとしたり、そもそも接続できなくなったりする問題が起こります。次回は、このリソース再生成に伴うIPアドレス変動の問題を取り上げます。

**[次回：第5回：仮想環境におけるIPアドレス変動対策](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-05/)**


---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-03/)　｜　[次の記事：【Ansible×Terraform編】第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-05/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第1部まとめブログ：環境構築・連携編で直面する9つのトラブル** **※近日公開予定**

---

[↑ 目次に戻る](#目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

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
|第10回|環境構築編まとめ：自動連携のためのコードテンプレート化|第1回〜9回の課題を踏まえ、TerraformからAnsibleへ一貫して安全に処理を移譲するためのコードのテンプレート化を解説。|

---

[↑ 目次に戻る](#目次)

---
