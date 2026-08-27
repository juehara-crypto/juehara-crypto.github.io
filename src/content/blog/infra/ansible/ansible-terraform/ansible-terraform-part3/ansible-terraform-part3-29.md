---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第29回：プロキシ環境等における外部コレクション（Ansible Galaxy）の取得失敗'
description: 'Terraformのlocal-exec経由でAnsible Playbookを実行する構成において、Playbookが依存する外部Collection（Ansible Galaxy配布）の取得がプロキシ環境、制限ネットワークで失敗し、local-exec全体が異常終了する構造を整理する。事前取得によるオフライン化、内部ミラーの利用という対処の選択肢もあわせて扱う。'
pubDate: '2026-08-29'
category: 'infra'
tags: ['Ansible', 'Terraform', 'Ansible Galaxy', 'Collection', 'プロキシ']
seriesId: 'ansible-terraform-part3'
seriesNo: 29
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/'
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
2. [Ansible CollectionとGalaxyの依存関係](#2-ansible-collectionとgalaxyの依存関係)
3. [プロキシ環境での取得失敗のパターン](#3-プロキシ環境での取得失敗のパターン)
4. [local-exec経由での失敗の伝播](#4-local-exec経由での失敗の伝播)
5. [オフライン環境での事前取得](#5-オフライン環境での事前取得)
6. [内部ミラー、プライベートリポジトリの利用](#6-内部ミラープライベートリポジトリの利用)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「Playbookさえ書けば、Ansibleはどこでも動く」と考えたことはないでしょうか。

**[第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)** では、対象OSがWindowsに変わることで、SSH接続という前提そのものが崩れる場面を扱いました。**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)** となる今回は、対象OSに関わらず発生する、Ansible自体の依存関係取得というレイヤーの問題を扱います。

Ansibleの主要なクラウド、ミドルウェア向けモジュールの多くは、Collectionという単位でAnsible本体から切り離されて配布されており、`ansible-galaxy collection install`によって外部リポジトリ（Ansible Galaxy）から取得する構造になっています。この取得コマンドは、`https://galaxy.ansible.com`への外部通信を前提としています。企業ネットワークやプロキシ経由でしかインターネットに出られない環境、あるいはセキュリティポリシー上外部通信自体が制限されている環境では、この取得コマンドがタイムアウトまたは接続拒否で失敗します。

Terraformの`local-exec`経由でこの取得コマンドを含むPlaybookを実行している場合、Collection取得の失敗はAnsible本体の実行にすら到達せず、そのまま`terraform apply`全体の異常終了として現れます。

この回で扱う問いは、「Playbook本体とは別に存在する依存関係の取得が、なぜインフラ全体の失敗として現れるのか」です。

次のセクションでは、この問いの前提となる、Ansible CollectionとGalaxyの依存関係という構造そのものを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. Ansible CollectionとGalaxyの依存関係

この回の前提となる、Collectionの依存関係の仕組みを整理します。

Ansibleの主要なクラウド、ミドルウェア向けモジュールの多くは、Collectionという単位でAnsible本体から切り離されて配布されています。Collectionを利用する場合、`requirements.yml`に依存を宣言したうえで、`ansible-galaxy collection install`コマンドで取得するという構造を取ります。これはnpm、pip等の一般的なパッケージ管理と同じ構造です。

検証環境では、Dockerコンテナの操作用モジュール群である`community.docker`Collectionを例に、この依存関係の構造を確認します。

* **ファイル名：**`requirements.yml`

```yaml
collections:
  - name: community.docker
    version: ">=3.0.0"
```

**実行コマンド**

```plaintext
ansible-galaxy collection install -r requirements.yml
```

**▼ 実行結果**

```plaintext
Starting galaxy collection install process
Process install dependency map
Starting collection install process
Downloading https://galaxy.ansible.com/api/v3/plugin/ansible/content/published/collections/artifacts/community-docker-5.2.2.tar.gz to /home/control/.ansible/tmp/ansible-local-45952sgcjprp/tmpo9p8qssa/community-docker-5.2.2-b4gix1c4
Installing 'community.docker:5.2.2' to '/home/control/.ansible/collections/ansible_collections/community/docker'
community.docker:5.2.2 was installed successfully
Downloading https://galaxy.ansible.com/api/v3/plugin/ansible/content/published/collections/artifacts/community-library_inventory_filtering_v1-1.1.5.tar.gz to /home/control/.ansible/tmp/ansible-local-45952sgcjprp/tmpo9p8qssa/community-library_inventory_filtering_v1-1.1.5-r8czr9qh
Installing 'community.library_inventory_filtering_v1:1.1.5' to '/home/control/.ansible/collections/ansible_collections/community/library_inventory_filtering_v1'
community.library_inventory_filtering_v1:1.1.5 was installed successfully
```

続けて、インストール結果を`ansible-galaxy collection list`で確認します。

**実行コマンド**

```plaintext
ansible-galaxy collection list
```

**▼ 実行結果**

```plaintext
# /home/control/.ansible/collections/ansible_collections
Collection                               Version
---------------------------------------- -------
community.docker                         5.2.2
community.library_inventory_filtering_v1 1.1.5
```

### ■ 結果

`requirements.yml`では`community.docker`のバージョンを`">=3.0.0"`と宣言しましたが、実際にインストールされたのは`5.2.2`でした。バージョン指定は下限のみを示すものであり、実際に取得されるバージョンは、その時点でAnsible Galaxy上に公開されている最新のものになります。

また、`community.docker`のインストールに伴い、`requirements.yml`には明記していない`community.library_inventory_filtering_v1`（1.1.5）も併せてインストールされました。これは`community.docker`が依存するCollectionであり、`ansible-galaxy collection install`が依存関係を自動的に解決した結果です。

この結果から分かる通り、`requirements.yml`に宣言する内容と、実際にインストールされる内容は必ずしも一致しません。宣言したCollection自体のバージョンが変動するだけでなく、宣言していない依存先のCollectionまで、この取得コマンドの対象に含まれます。次のセクションでは、この取得コマンドがプロキシ環境、制限ネットワークでどのように失敗するかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. プロキシ環境での取得失敗のパターン

前セクションで確認した`ansible-galaxy collection install`は、外部通信が制限された環境ではどのように失敗するのかを確認します。

到達できないプロキシアドレスを`https_proxy`環境変数に設定した状態で、`community.docker`Collectionの取得を試みます。

### ■ 検証内容：到達不能なプロキシ経由でのCollection取得

**実行コマンド**

```plaintext
export https_proxy=http://10.255.255.1:8080
ansible-galaxy collection install -r requirements.yml
```

**▼ 実行結果**

```plaintext
Starting galaxy collection install process
Process install dependency map
[WARNING]: Skipping Galaxy server https://galaxy.ansible.com/api/. Got an unexpected error when getting available versions of collection community.docker: Unknown error when attempting to
call Galaxy at 'https://galaxy.ansible.com/api/v3/collections/community/docker/': <urlopen error [Errno 111] Connection refused>. <urlopen error [Errno 111] Connection refused>
ERROR! Unknown error when attempting to call Galaxy at 'https://galaxy.ansible.com/api/v3/collections/community/docker/': <urlopen error [Errno 111] Connection refused>. <urlopen error [Errno 111] Connection refused>
```

### ■ 結果

`https_proxy`に到達できないアドレスを指定した状態で`ansible-galaxy collection install`を実行すると、`galaxy.ansible.com`への通信がプロキシ経由で試みられ、`Connection refused`（Errno 111）という形で失敗しました。

このエラーは、通信が無応答のまま止まるタイムアウトとは異なり、接続先から明示的に「拒否された」という応答が返ってきていることを示しています。プロキシとして指定したアドレス、ポートに対して実際には何も待ち受けていない場合や、意図しないアドレスを誤って指定してしまった場合に、このような即時の拒否が発生します。

`ansible-galaxy collection install`は、この時点でGalaxyサーバーへの接続を`[WARNING]: Skipping Galaxy server`として一度スキップした後、最終的に`ERROR!`としてコマンド自体を異常終了させています。ここで押さえておくべき点は、この失敗がPlaybook内のタスクの失敗ではなく、Collectionの取得コマンドという、Playbook実行より前の段階で発生しているという点です。この構造が、次のセクションで扱う`local-exec`経由での失敗の伝播につながります。

---

[↑ 目次に戻る](#-目次)

---

## 4. local-exec経由での失敗の伝播

前セクションで確認した取得失敗が、Terraformの`local-exec`経由で実行した場合にどう見えるかを確認します。

`null_resource.provision`の`local-exec`コマンドを、`ansible-galaxy collection install`の後に`&&`で`ansible-playbook`を連結する構成に変更します。

* **ファイル名：**`main.tf`（該当箇所）

```hcl
resource "null_resource" "provision" {
  depends_on = [local_file.ansible_inventory]
  provisioner "local-exec" {
    command = "ansible-galaxy collection install -r requirements.yml && ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/ansible-run.log ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_normal.yml"
  }
}
```

`&&`はシェルの制御演算子であり、前段のコマンドが成功した場合にのみ後段のコマンドを実行します。この構成では、`ansible-galaxy collection install`が失敗した場合、後段の`ansible-playbook`は起動すらされません。

`https_proxy`に到達できないアドレスを設定した状態のまま、この構成で`terraform apply`を実行します。

### ■ 検証内容：プロキシ接続失敗時のlocal-exec全体の挙動確認

**実行コマンド**

```plaintext
terraform apply -replace="null_resource.provision"
```

**▼ 実行結果**

```plaintext
Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # null_resource.provision will be replaced, as requested
-/+ resource "null_resource" "provision" {
      ~ id = "7457233514236216081" -> (known after apply)
    }

Plan: 1 to add, 0 to change, 1 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.provision: Destroying... [id=7457233514236216081]
null_resource.provision: Destruction complete after 0s
null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ansible-galaxy collection install -r requirements.yml && ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/ansible-run.log ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_normal.yml"]
null_resource.provision: Still creating... [00m10s elapsed]
null_resource.provision: Still creating... [00m20s elapsed]
null_resource.provision (local-exec): [WARNING]: Skipping Galaxy server https://galaxy.ansible.com/api/. Got an
null_resource.provision (local-exec): unexpected error when getting available versions of collection
null_resource.provision (local-exec): community.docker: Unknown error when attempting to call Galaxy at
null_resource.provision (local-exec): 'https://galaxy.ansible.com/api/v3/collections/community/docker/': <urlopen
null_resource.provision (local-exec): error [Errno 111] Connection refused>. <urlopen error [Errno 111] Connection
null_resource.provision (local-exec): refused>
null_resource.provision (local-exec): ERROR! Unknown error when attempting to call Galaxy at 'https://galaxy.ansible.com/api/v3/collections/community/docker/': <urlopen error [Errno 111] Connection refused>. <urlopen error [Errno 111] Connection refused>
null_resource.provision (local-exec): Starting galaxy collection install process
null_resource.provision (local-exec): Process install dependency map
╷
│ Error: local-exec provisioner error
│
│   with null_resource.provision,
│   on main.tf line 121, in resource "null_resource" "provision":
│  121:   provisioner "local-exec" {
│
│ Error running command 'ansible-galaxy collection install -r requirements.yml && ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/ansible-run.log ansible-playbook -i inventory.ini
│ ../ansible/playbooks/test_nested_normal.yml': exit status 1. Output: [WARNING]: Skipping Galaxy server https://galaxy.ansible.com/api/. Got an
│ unexpected error when getting available versions of collection
│ community.docker: Unknown error when attempting to call Galaxy at
│ 'https://galaxy.ansible.com/api/v3/collections/community/docker/': <urlopen
│ error [Errno 111] Connection refused>. <urlopen error [Errno 111] Connection
│ refused>
│ ERROR! Unknown error when attempting to call Galaxy at 'https://galaxy.ansible.com/api/v3/collections/community/docker/': <urlopen error [Errno 111] Connection refused>. <urlopen error
│ [Errno 111] Connection refused>
│ Starting galaxy collection install process
│ Process install dependency map
│
╵
```

### ■ 結果

`terraform apply`は`exit status 1`で異常終了し、`Error: local-exec provisioner error`となりました。

ここで注目すべきは、`Output:`以降に再掲されている内容です。`[WARNING]`、`ERROR!`という`ansible-galaxy collection install`のエラーメッセージのみが含まれており、`PLAY`や`TASK`、`PLAY RECAP`といった、`ansible-playbook`が実際に起動した場合に現れるはずの出力が一切存在しません。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** で整理した通り、`Error: local-exec provisioner error`ブロックの`Error running command`の一文だけを見ても、失敗したのが連結コマンドのどちら側かは分かりません。この一文には、`&&`で結ばれたコマンド全体がそのまま表示されているためです。区別するには、第21回と同様に`Output:`以降の内容を実際に読み、`PLAY`という文字列の有無を確認する必要があります。今回のログには`PLAY`が存在しないことから、この失敗が`ansible-playbook`側のタスク失敗ではなく、それより前段の`ansible-galaxy collection install`の段階で発生していると特定できます。

この結果から分かるのは、`local-exec`内でCollectionの取得コマンドをPlaybook実行前に挟む構成を取ると、取得コマンドの失敗がPlaybook本体の実行機会そのものを奪い、`terraform apply`全体の異常終了として一括りに現れるという構造です。Terraformのエラー表示だけを見ている限り、この失敗がAnsibleのタスク設計の問題なのか、依存関係の取得段階の問題なのかを区別する手がかりは、`Output:`の中身を読み解く以外にありません。

---

[↑ 目次に戻る](#-目次)

---

## 5. オフライン環境での事前取得

前セクションまでで確認した取得失敗への回避策として、Collectionを事前にダウンロードし、外部通信なしでインストールする方法を確認します。

`ansible-galaxy collection download`コマンドを使うと、Collectionのtarボールをローカルディレクトリに取得できます。

### ■ 検証内容：ansible-galaxy collection downloadによる事前取得

**実行コマンド**

```plaintext
ansible-galaxy collection download -r requirements.yml -p ./collections
```

**▼ 実行結果**

```plaintext
Process download dependency map
Starting collection download process to '/home/control/iac/docker-lab/collections'
Downloading https://galaxy.ansible.com/api/v3/plugin/ansible/content/published/collections/artifacts/community-docker-5.2.2.tar.gz to /home/control/.ansible/tmp/ansible-local-5046xnyuob2y/tmpko5k02hh/community-docker-5.2.2-0cywicyt
Downloading collection 'community.docker:5.2.2' to '/home/control/iac/docker-lab/collections'
Downloading https://galaxy.ansible.com/api/v3/plugin/ansible/content/published/collections/artifacts/community-library_inventory_filtering_v1-1.1.5.tar.gz to /home/control/.ansible/tmp/ansible-local-5046xnyuob2y/tmpko5k02hh/community-library_inventory_filtering_v1-1.1.5-9uwrs1km
Collection 'community.docker:5.2.2' was downloaded successfully
Downloading collection 'community.library_inventory_filtering_v1:1.1.5' to '/home/control/iac/docker-lab/collections'
Collection 'community.library_inventory_filtering_v1:1.1.5' was downloaded successfully
Writing requirements.yml file of downloaded collections to '/home/control/iac/docker-lab/collections/requirements.yml'
```

`community.docker`本体だけでなく、その依存先である`community.library_inventory_filtering_v1`のtarボールも併せてダウンロードされ、ダウンロード結果を反映した`requirements.yml`も生成されます。ダウンロードされたファイルを確認します。

**実行コマンド**

```plaintext
ls -la ./collections
```

**▼ 実行結果**

```plaintext
total 632
drwxrwxr-x 2 control control   4096 Aug 27 06:15 .
drwxrwxr-x 7 control docker    4096 Aug 27 06:15 ..
-rw-rw-r-- 1 control control 595920 Aug 27 06:15 community-docker-5.2.2.tar.gz
-rw-rw-r-- 1 control control  36002 Aug 27 06:15 community-library_inventory_filtering_v1-1.1.5.tar.gz
-rw-rw-r-- 1 control control    147 Aug 27 06:15 requirements.yml
```

続けて、外部通信が制限された環境で、これらのtarボールからインストールできるかを確認します。まず、依存先を含めず`community.docker`のtarボールのみを指定します。

### ■ 検証内容（1）：依存先を指定せずローカルインストールした場合

**実行コマンド**

```plaintext
ansible-galaxy collection install ./collections/community-docker-5.2.2.tar.gz
```

**▼ 実行結果**

```plaintext
Starting galaxy collection install process
Process install dependency map
[WARNING]: Skipping Galaxy server https://galaxy.ansible.com/api/. Got an unexpected error when getting available versions of collection community.library_inventory_filtering_v1: Unknown
error when attempting to call Galaxy at 'https://galaxy.ansible.com/api/v3/collections/community/library_inventory_filtering_v1/': <urlopen error [Errno 111] Connection refused>. <urlopen
error [Errno 111] Connection refused>
ERROR! Unknown error when attempting to call Galaxy at 'https://galaxy.ansible.com/api/v3/collections/community/library_inventory_filtering_v1/': <urlopen error [Errno 111] Connection refused>. <urlopen error [Errno 111] Connection refused>
```

`community.docker`本体のtarボールはローカルパスから指定していますが、インストールは失敗しました。エラーの対象は`community.docker`ではなく、依存先の`community.library_inventory_filtering_v1`です。`community.docker`のtarボールをローカルに用意しても、依存関係の解決先までは自動的にローカルへ切り替わらず、`ansible-galaxy`は依存先のバージョン情報を得るためにGalaxyへ問い合わせに行きます。この問い合わせが、外部通信の制限によって失敗しています。

続けて、依存先のtarボールも合わせて指定します。

### ■ 検証内容（2）：依存先を含めてローカルインストールした場合

**実行コマンド**

```plaintext
ansible-galaxy collection install ./collections/community-docker-5.2.2.tar.gz ./collections/community-library_inventory_filtering_v1-1.1.5.tar.gz
```

**▼ 実行結果**

```plaintext
Starting galaxy collection install process
Process install dependency map
Starting collection install process
Installing 'community.docker:5.2.2' to '/home/control/.ansible/collections/ansible_collections/community/docker'
community.docker:5.2.2 was installed successfully
Installing 'community.library_inventory_filtering_v1:1.1.5' to '/home/control/.ansible/collections/ansible_collections/community/library_inventory_filtering_v1'
community.library_inventory_filtering_v1:1.1.5 was installed successfully
```

今度は外部通信に関するエラーが一切発生せず、両方のCollectionが正常にインストールされました。`ansible-galaxy collection list`でも、インストール結果を確認できます。

**実行コマンド**

```plaintext
ansible-galaxy collection list
```

**▼ 実行結果**

```plaintext
# /home/control/.ansible/collections/ansible_collections
Collection                               Version
---------------------------------------- -------
community.docker                         5.2.2
community.library_inventory_filtering_v1 1.1.5
```

### ■ 結果

`ansible-galaxy collection download`は、指定したCollection本体だけでなく、依存関係にあるCollectionのtarボールも合わせてダウンロードします。しかし、`ansible-galaxy collection install`にローカルパスを指定する際、対象となるCollection本体のtarボールのみを指定すると、依存先の解決はGalaxyへの問い合わせに頼ったままになり、外部通信が制限された環境では失敗します。

外部通信を完全に排除してインストールするには、依存先を含めたすべてのtarボールを、インストールコマンドの引数として明示的に指定する必要があります。`ansible-galaxy collection download`が依存先まで含めてダウンロードしてくれる仕組みは、この後段のインストール作業で依存先を漏れなく指定するための準備という位置づけになります。

---

[↑ 目次に戻る](#-目次)

---

## 6. 内部ミラー、プライベートリポジトリの利用

ここまでのセクションで、事前ダウンロードによってオフライン化する方法を確認しました。このセクションでは、継続的にCollectionを利用する組織向けの、恒久的な対処の選択肢を整理します。

`ansible-galaxy`は、参照先のGalaxyサーバーを`ansible.cfg`の`server_list`で切り替えられます。組織内にCollectionのミラーやプライベートリポジトリ（Automation Hub相当）を用意している場合、この設定によって参照先を内部ミラーに切り替えることができます。

* **ファイル名：**`ansible.cfg`

```ini
[galaxy]
server_list = internal_mirror

[galaxy_server.internal_mirror]
url=https://internal-galaxy.example.local/
```

`server_list`に指定したサーバー名（`internal_mirror`）に対応する`[galaxy_server.internal_mirror]`セクションで、実際の参照先URLを指定します。この設定を行うことで、`ansible-galaxy collection install`が参照する先が`galaxy.ansible.com`から内部ミラーへ切り替わり、外部ネットワークへの通信自体が発生しなくなります。

前セクションで扱った事前ダウンロード、ローカルインストールは、実行のたびに手元でtarボールを管理する必要がある方法でした。これに対して内部ミラーの利用は、一度構築してしまえば、通常の`ansible-galaxy collection install -r requirements.yml`のコマンドをそのまま使い続けられるという違いがあります。継続的にCollectionを利用し、複数の環境、複数のメンバーで同じ依存関係を扱う組織にとっては、事前ダウンロードを都度繰り返すよりも、この恒久的な参照先の切り替えの方が運用上扱いやすい選択肢になります。

内部ミラー自体の構築、運用手順は、この回の範囲では扱いません。組織内にすでにそうした基盤がある場合の選択肢として、参照先の切り替え方法のみをここで示しました。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* Ansibleの主要なモジュール群の多くはCollectionという単位でAnsible本体から切り離されて配布されており、`requirements.yml`に依存を宣言したうえで`ansible-galaxy collection install`で取得する。この取得コマンドは`https://galaxy.ansible.com`への外部通信を前提としている
* `requirements.yml`に宣言したバージョンはあくまで下限の指定であり、実際に取得されるバージョンは、その時点でGalaxy上に公開されている最新のものになる。また、宣言していない依存先のCollectionまで、取得コマンドの対象に自動的に含まれる
* 到達できないプロキシ経由での取得は、無応答のタイムアウトではなく、接続先から明示的に拒否される`Connection refused`という形で失敗することがある
* `local-exec`内でCollectionの取得コマンドをPlaybook実行前に`&&`で連結する構成では、取得コマンドの失敗がPlaybook本体の実行機会を奪い、`terraform apply`全体の異常終了として一括りに現れる。この失敗がAnsibleのタスク失敗なのか依存解決コマンドの失敗なのかは、`Error:`ブロックの`Output:`以降を読み、`PLAY`という文字列の有無を確認しなければ区別できない
* `ansible-galaxy collection download`による事前取得は、対象Collectionだけでなく依存先のCollectionのtarボールも併せてダウンロードする。ただし`ansible-galaxy collection install`でローカルインストールする際、依存先のtarボールを明示的に指定しなければ、依存解決のためのGalaxyへの問い合わせが発生し、外部通信が制限された環境では失敗する。依存先まで含めてすべて指定することで、初めて完全にオフラインでのインストールが成立する
* 継続的にCollectionを利用する組織には、`ansible.cfg`の`server_list`で参照先を内部ミラー、プライベートリポジトリに切り替えるという、恒久的な選択肢がある

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)** では、対象OSがWindowsに変わることで、SSH接続という前提そのものが崩れる場面を扱いました。**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)** となる今回は、対象OSに関わらず発生する、Ansible自体の依存関係取得というレイヤーの問題を扱いました。プロキシ環境での取得失敗が`local-exec`全体の異常終了としてどう現れるか、そして事前取得によるオフライン化がどこまで有効かを、実機検証を交えて確認しました。

次回は、依存関係取得という「実行前提の準備段階」の問題から離れ、`TF_LOG`と`-vvvv`を組み合わせたデバッグフラグの活用という、第3部全体で扱ってきた原因特定手法の集大成に入ります。

**[次回：第30回：デバッグフラグの組み合わせによるログ解析の高度化](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)　｜　[次の記事：【Ansible×Terraform編】第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)**

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