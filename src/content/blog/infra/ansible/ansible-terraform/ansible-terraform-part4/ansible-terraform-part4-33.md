---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第33回：`triggers`を用いたAnsible再実行の最適化設計'
description: '`null_resource`や`terraform_data`の`triggers`／`triggers_replace`を用い、Playbookの内容に変更がない場合はAnsible実行そのものをスキップする設計を扱う。Terraformの状態管理の仕組みによる、プロビジョニング処理の最適化を整理する。'
pubDate: 2026-09-03
category: 'infra'
tags: ['Ansible', 'Terraform', 'triggers', 'terraform_data', 'CI/CD']
seriesId: 'ansible-terraform-part4'
seriesNo: 33
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/'
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
2. [変更の有無に関わらずAnsibleが毎回実行される問題の所在](#2-変更の有無に関わらずansibleが毎回実行される問題の所在)
3. [null_resourceとtriggersの基本構造](#3-null_resourceとtriggersの基本構造)
4. [terraform_dataとtriggers_replace](#4-terraform_dataとtriggers_replace)
5. [コード変更の検知によるAnsible実行の抑制](#5-コード変更の検知によるansible実行の抑制)
6. [検証環境での動作確認](#6-検証環境での動作確認)
7. [triggersに何を含めるかという設計判断](#7-triggersに何を含めるかという設計判断)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#10-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「Playbookの内容は何も変えていないのに、`terraform apply`を実行するたびにAnsibleがまるごと走ってしまう」という状態に、無駄を感じたことはないでしょうか。

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** では、`local-exec`経由でAnsibleを直接実行する密結合構成を見直し、Terraformの責務を状態（tfstate、`output`）の出力に限定する疎結合設計への移行を扱いました。**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** では、この疎結合化によって生じた「実行順序をどう保証するか」という課題に対し、GitHub Actions上でコンテナの起動からAnsible適用までを一連のジョブとして自動実行する仕組みを扱いました。いずれも、TerraformとAnsibleをどのタイミングで、どういう順序で実行するかという設計が軸になっていました。

第33回となる今回は、視点を変えます。実行するかどうかという判断そのものを扱う回です。

第1部から第4部を通じて、検証環境では`terraform apply`実行のたびにAnsible Playbookを適用する構成を取ってきました。この方式では、Playbookの内容に変更がない場合でも、`terraform apply`を実行するたびに同じAnsible実行が繰り返されます。`null_resource`（および`terraform_data`）が持つ`triggers`（`triggers_replace`）引数を使うと、指定した値の変化を検知してリソースの再作成を制御できます。この性質を利用し、Playbookファイルの内容に変更がない限りAnsible実行そのものをスキップする設計を、この回で扱います。

問いは、「Terraformが元々持っている状態管理の仕組みを使って、Ansible実行の要否そのものを制御できないか」です。

次のセクションでは、この回で解決する課題を具体的に確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 変更の有無に関わらずAnsibleが毎回実行される問題の所在

この回で解決する課題を、実機で確認します。

検証環境の`main.tf`では、`null_resource.provision`が`local-exec`経由で`ansible-playbook -i inventory.ini site.yml`を実行する構成になっています。Playbook（`site.yml`）の内容を一切変更せずに`terraform apply`を連続して実行し、Ansible実行がそのたびに走るかどうかを確認します。
```

【現状の構成】  
terraform apply実行（コード変更の有無に関わらず）  
　↓  
Ansible Playbook実行（前回と同じ内容でも毎回フル実行）

````

### ■ 検証内容：Playbook未変更時における連続terraform applyの確認

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果（1回目）**

```plaintext
（途中省略：Refreshing state、docker_containerおよびlocal_fileの作成計画詳細）

  # null_resource.provision will be created
  + resource "null_resource" "provision" {
      + id       = (known after apply)
      + triggers = {
          + "always_run" = (known after apply)
        }
    }

Plan: 6 to add, 0 to change, 2 to destroy.

（途中省略：Changes to Outputs）

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

（途中省略：docker_container、local_fileの作成完了ログ）

null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ansible-playbook -i inventory.ini site.yml"]

null_resource.provision (local-exec): PLAY [接続確認用Playbook] ******************************************************

null_resource.provision (local-exec): TASK [疎通確認] ****************************************************************
（途中省略：Pythonインタープリタ検出に関するWARNING）
null_resource.provision (local-exec): ok: [target-node1]
null_resource.provision (local-exec): ok: [target-node3]
null_resource.provision (local-exec): ok: [target-node2]

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

null_resource.provision: Creation complete after 5s [id=6756648241611803359]

Apply complete! Resources: 6 added, 0 changed, 2 destroyed.
```

続けて、`site.yml`を一切変更せずに、同じコマンドを再度実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果（2回目）**

```plaintext
（途中省略：Refreshing state）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

（途中省略：local_file.ansible_inventory、local_file.group_vars_target_nodesの差分詳細）

  # null_resource.provision must be replaced
-/+ resource "null_resource" "provision" {
      ~ id       = "6756648241611803359" -> (known after apply)
      ~ triggers = { # forces replacement
          ~ "always_run" = "2026-09-03T02:38:32Z" -> (known after apply)
        }
    }

Plan: 3 to add, 0 to change, 3 to destroy.

（途中省略：Changes to Outputs）

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.provision: Destroying... [id=6756648241611803359]
null_resource.provision: Destruction complete after 0s

（途中省略：local_fileの再作成ログ）

null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ansible-playbook -i inventory.ini site.yml"]

null_resource.provision (local-exec): PLAY [接続確認用Playbook] ******************************************************

null_resource.provision (local-exec): TASK [疎通確認] ****************************************************************
（途中省略：Pythonインタープリタ検出に関するWARNING）
null_resource.provision (local-exec): ok: [target-node3]
null_resource.provision (local-exec): ok: [target-node1]
null_resource.provision (local-exec): ok: [target-node2]

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

null_resource.provision: Creation complete after 2s [id=1958651358544580040]

Apply complete! Resources: 3 added, 0 changed, 3 destroyed.
```

### ■ 結果

`site.yml`の内容を1回目、2回目とも一切変更していないにもかかわらず、`terraform apply`を実行するたびに`null_resource.provision`が再作成され、`local-exec`によるAnsible実行（`ansible-playbook -i inventory.ini site.yml`）がそのたびに走ることが確認できました。2回とも、target-node1〜3のすべてで`ok=1、changed=0、unreachable=0、failed=0`という同一の結果が返っています。

```
Playbookに変更を加えずに、連続でterraform applyを実行する  
　↓  
毎回Ansible実行が走ることを確認する  
　↓  
Playbookの内容が変わっていないにも関わらず、実行を避ける手段がない状態を確認する
```

`null_resource`は`triggers`引数を指定しない場合でも、依存関係のあるリソースの状態次第で再作成されることがありますが、今回のような、Playbookの内容とは無関係にAnsible実行が毎回走ってしまう状態を確認したうえで、次のセクションでは、この`triggers`引数を使って再作成の要否そのものを制御する仕組みを扱います。


---

[↑ 目次に戻る](#-目次)

---

## 3. `null_resource`と`triggers`の基本構造

この回で使う仕組みの土台を確認します。

`null_resource`は実際のインフラリソースを作成しないTerraformの特殊なリソースタイプで、`triggers`引数に指定した値が変化したときにのみ再作成される性質を持ちます。この`triggers`引数に、Playbookファイルのハッシュ値を指定することで、Ansible実行の要否を制御する構成を確認します。

* **ファイル名：`main.tf`（該当箇所）**

**【変更前】**

```hcl
resource "null_resource" "provision" {
  triggers = {
    always_run = timestamp()
  }
  depends_on = [local_file.ansible_inventory]
  provisioner "local-exec" {
    command = "ansible-playbook -i inventory.ini site.yml"
  }
}
```

**【変更後】**

```hcl
resource "null_resource" "provision" {
  triggers = {
    playbook_hash = filesha256("${path.module}/site.yml")
  }
  depends_on = [local_file.ansible_inventory]
  provisioner "local-exec" {
    command = "ansible-playbook -i inventory.ini site.yml"
  }
}
```

`filesha256`は、指定したファイルの中身からSHA-256のハッシュ値を計算する関数です。ファイルの中身が1バイトでも変わればハッシュ値は別の値になり、中身が完全に同一であれば、何度計算しても同じハッシュ値が返ります。

`triggers`は、この値をTerraformのstateに保存し、`terraform apply`のたびに以下の判定を行う仕組みです。
````

【triggersの判定フロー】  
terraform apply実行  
　↓  
triggersに指定した式を再評価し、新しい値を計算する  
　↓  
stateに保存されている前回の値と比較する  
　↓  
一致 → リソースは再作成されない（Ansible実行はスキップ）  
不一致 → リソースが再作成される（Ansible実行が走る）

````

この仕組みにより、`site.yml`の内容を変更しない限り`filesha256`が返す値は変わらず、`null_resource.provision`は再作成されません。内容を変更した場合のみ、ハッシュ値が変わり、再作成（＝Ansible実行）が走る構造になります。

### ■ 検証内容：triggers変更後における1回目のterraform apply確認

`always_run`（`timestamp()`）から`playbook_hash`（`filesha256`）へ`triggers`の記述を変更したうえで、`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # null_resource.provision must be replaced
-/+ resource "null_resource" "provision" {
      ~ id       = "1958651358544580040" -> (known after apply)
      ~ triggers = { # forces replacement
          - "always_run"    = "2026-09-03T02:40:35Z" -> null
          + "playbook_hash" = "cf440c8853fa0faf72d3d75d0f319ab4cd82ece21ff0c6aebe4c3eede2f361e6"
        }
    }

Plan: 1 to add, 0 to change, 1 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.provision: Destroying... [id=1958651358544580040]
null_resource.provision: Destruction complete after 0s
null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ansible-playbook -i inventory.ini site.yml"]

null_resource.provision (local-exec): PLAY [接続確認用Playbook] ******************************************************

null_resource.provision (local-exec): TASK [疎通確認] ****************************************************************
（途中省略：Pythonインタープリタ検出に関するWARNING）
null_resource.provision (local-exec): ok: [target-node3]
null_resource.provision (local-exec): ok: [target-node2]
null_resource.provision (local-exec): ok: [target-node1]

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

null_resource.provision: Creation complete after 3s [id=6200970946844839026]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
```

### ■ 結果

`Plan`の対象は`null_resource.provision`のみであり、`docker_container.targets`をはじめとする他のリソースは作成計画に含まれていません。`Apply complete! Resources: 1 added, 0 changed, 1 destroyed`が示しているのも、`null_resource.provision`が1つ破棄され、1つ作成されたことのみです。

この1回の再作成は、`playbook_hash`の値同士を比較した結果ではありません。`triggers`のキーが`always_run`から`playbook_hash`へと変わったことで、stateには比較対象となる前回の`playbook_hash`の値が存在しない状態になっており、比較のしようがないまま無条件で再作成されています。この実行によって、`site.yml`から計算されたハッシュ値（`cf440c8853fa0faf72d3d75d0f319ab4cd82ece21ff0c6aebe4c3eede2f361e6`）が、比較の基準としてstateに新規登録されたことになります。

### ■ 検証内容：Playbook未変更時における2回目のterraform apply確認

`site.yml`を変更せずに、続けて`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state）
No changes. Your infrastructure matches the configuration.
Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
Apply complete! Resources: 0 added, 0 changed, 0 destroyed.
Outputs:
target_nodes = {
  "target-node1" = {
    "host" = "172.18.0.2"
    "port" = 22
  }
  "target-node2" = {
    "host" = "172.20.0.3"
    "port" = 22
  }
  "target-node3" = {
    "host" = "172.20.0.4"
    "port" = 22
  }
}
target_nodes_ips = {
  "target-node1" = "172.18.0.2"
  "target-node2" = "172.20.0.3"
  "target-node3" = "172.20.0.4"
}
```

### ■ 結果

`Apply complete! Resources: 0 added, 0 changed, 0 destroyed`となり、`null_resource.provision`は再作成されず、`local-exec`によるAnsible実行も走りませんでした。前回の実行でstateに保存された`playbook_hash`の値と、今回`filesha256`で再計算された値が一致したためです。

このログの中に、ハッシュ値同士を比較した過程そのものを示す行はありません。比較が行われたことを示しているのは、`Terraform has compared your real infrastructure against your configuration and found no differences`という一文です。差分がない場合、Terraformは比較した値の中身をログに出力しません。1回目の実行結果で見た`~ "playbook_hash" = "旧値" -> "新値"`という表示は、差分が「ある」場合にのみ現れる表示であり、差分が「ない」場合は`No changes`という結論のみが報告される、という違いになります。

`site.yml`の内容を一切変更していない状態で`null_resource.provision`の再作成が発生しなかったことにより、`filesha256`をtriggersに指定することで、Playbookが変わらない限りAnsible実行そのものがスキップされる構造を確認できました。

---

[↑ 目次に戻る](#-目次)

---

## 4. `terraform_data`と`triggers_replace`

セクション3では`null_resource`を使いましたが、同じ目的を実現できるもう一つの選択肢を確認します。

Terraform 1.4以降で導入された`terraform_data`は、`null_resource`と同じ目的（実インフラを作らず、値の変化を検知する）のために使えるリソースタイプです。`null_resource`が`null` providerというHashiCorp公式の外部providerに依存しているのに対し、`terraform_data`はTerraform本体に組み込まれたビルトインのリソースタイプであり、providerのインストールやバージョン管理が不要です。

* **ファイル名：`main.tf`（記法の対比、参考）**

```hcl
resource "terraform_data" "ansible_provision" {
  triggers_replace = {
    playbook_hash = filesha256("${path.module}/site.yml")
  }

  provisioner "local-exec" {
    command = "ansible-playbook -i dynamic_inventory.py site.yml"
  }
}
```

`null_resource`の`triggers`と、`terraform_data`の`triggers_replace`は、指定した値が変化したときにリソースを再作成するという役割としては同じです。名称が異なるのは、`terraform_data`が`null_resource`よりも後発のビルトインリソースであり、`triggers_replace`という、より明示的な名称が採用されているためです。

|項目|`null_resource`|`terraform_data`|
|---|---|---|
|提供元|`null` provider（外部provider）|Terraform本体（ビルトイン）|
|変更検知の引数|`triggers`|`triggers_replace`|
|providerのバージョン管理|必要|不要|
|`provisioner`との組み合わせ|可能|可能|

この回以降のサンプルは、セクション3から引き続き`null_resource`をベースに進めます。検証環境の`main.tf`にすでに`null_resource.provision`が存在しており、`terraform_data`へ切り替える必然性が今回はないためです。ただし、`triggers`と`triggers_replace`は果たす役割が同じであるため、ここまで確認してきた挙動（ハッシュ値が変わらない限り再作成されない）は、`terraform_data`を使った場合でも構造上の違いはありません。

---

[↑ 目次に戻る](#-目次)

---

## 5. コード変更の検知によるAnsible実行の抑制

セクション3では`filesha256`による単一ファイルのハッシュ値検知を確認しました。しかし、Playbookが複数のファイル（Role内の複数タスクファイル等）から構成される場合、`filesha256`は1つのファイルしか対象にできません。このセクションでは、`fileset`関数を使い、Roleディレクトリ配下の複数ファイルにまたがる変更をまとめて検知する構成を確認します。

検証環境には、`site.yml`から呼び出す`roles/common`ディレクトリを新規に作成しました。

* **ファイル名：`roles/common/tasks/main.yml`**

```yaml
---
- name: 疎通確認（common role）
  ansible.builtin.ping:
```

* **ファイル名：`site.yml`**

```yaml
---
- name: 接続確認用Playbook
  hosts: target_nodes
  gather_facts: false

  roles:
    - common
```

`main.tf`側は、`fileset`関数でRoleディレクトリ配下の全YAMLファイルを走査し、それぞれのハッシュ値を結合してさらにハッシュ化する構成に変更します。

* **ファイル名：`main.tf`（該当箇所）**

**【変更前】**

```hcl
resource "null_resource" "provision" {
  triggers = {
    playbook_hash = filesha256("${path.module}/site.yml")
  }
  depends_on = [local_file.ansible_inventory]
  provisioner "local-exec" {
    command = "ansible-playbook -i inventory.ini site.yml"
  }
}
```

**【変更後】**

```hcl
locals {
  playbook_files = fileset("${path.module}/roles", "**/*.yml")
  playbook_hash  = sha256(join("", [for f in local.playbook_files : filesha256("${path.module}/roles/${f}")]))
}

resource "null_resource" "provision" {
  triggers = {
    playbook_hash = local.playbook_hash
  }
  depends_on = [local_file.ansible_inventory]
  provisioner "local-exec" {
    command = "ansible-playbook -i inventory.ini site.yml"
  }
}
```

`fileset("${path.module}/roles", "**/*.yml")`は、`roles`ディレクトリ配下にある拡張子`.yml`のファイルを、サブディレクトリを含めて再帰的に走査します。`[for f in local.playbook_files : filesha256("${path.module}/roles/${f}")]`で、走査した各ファイルのハッシュ値をそれぞれ計算し、`join("", ...)`でそれらを1本の文字列に連結したうえで、`sha256(...)`で改めてハッシュ化します。これにより、対象ファイルのうちどれか1つでも内容が変わった場合、連結後の文字列が変わり、最終的な`playbook_hash`の値も変わる構造になります。

### ■ 検証内容：fileset切り替え後における1回目のterraform apply確認

`triggers`の値を、単一ファイルのハッシュ値（`filesha256`）から`fileset`による結合ハッシュ（`local.playbook_hash`）へ切り替えたうえで、`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state）

Terraform will perform the following actions:

  # null_resource.provision must be replaced
-/+ resource "null_resource" "provision" {
      ~ id       = "6200970946844839026" -> (known after apply)
      ~ triggers = { # forces replacement
          ~ "playbook_hash" = "cf440c8853fa0faf72d3d75d0f319ab4cd82ece21ff0c6aebe4c3eede2f361e6" -> "f4ac937b578661ca2b805819440374198a8defd35d438afb3cf1e9c3f9212c32"
        }
    }

Plan: 1 to add, 0 to change, 1 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.provision: Destroying... [id=6200970946844839026]
null_resource.provision: Destruction complete after 0s
null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ansible-playbook -i inventory.ini site.yml"]

null_resource.provision (local-exec): PLAY [接続確認用Playbook] ******************************************************

null_resource.provision (local-exec): TASK [common : 疎通確認（common role）] ****************************************
（途中省略：Pythonインタープリタ検出に関するWARNING）
null_resource.provision (local-exec): ok: [target-node2]
null_resource.provision (local-exec): ok: [target-node3]
null_resource.provision (local-exec): ok: [target-node1]

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

null_resource.provision: Creation complete after 6s [id=6805260346048414665]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
```

### ■ 結果

`playbook_hash`の値が、単一ファイルのハッシュ値から、`fileset`による結合ハッシュへと変わったため、比較対象となる前回の値が存在しない状態となり、`null_resource.provision`が再作成されました。`local-exec`のログでは、タスク名が`TASK [common : 疎通確認（common role）]`となっており、`site.yml`から`roles/common`が正しく呼び出されていることが確認できます。この実行によって、`roles`配下のファイル構成から計算されたハッシュ値（`f4ac937b...`）が、比較の基準として新たにstateに登録されました。

### ■ 検証内容：Role未変更時における2回目のterraform apply確認

Roleファイルを変更せずに、続けて`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state）
No changes. Your infrastructure matches the configuration.
Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
Apply complete! Resources: 0 added, 0 changed, 0 destroyed.
```

### ■ 結果

`No changes`となり、`null_resource.provision`は再作成されず、`local-exec`によるAnsible実行も走りませんでした。`roles/common/tasks/main.yml`の内容を変更していないため、`fileset`で走査したファイルのハッシュ値が前回と一致し、結合後の`playbook_hash`も同一になったためです。単一ファイルを対象にした場合（セクション3）と同じ挙動が、複数ファイルを対象にした場合でも成立することが確認できました。

### ■ 検証内容：Role変更時における3回目のterraform apply確認

続けて、`roles/common/tasks/main.yml`のタスク名を変更します。

* **ファイル名：`roles/common/tasks/main.yml`**

【変更前】

```yaml
---
- name: 疎通確認（common role）
  ansible.builtin.ping:
```

【変更後】

```yaml
---
- name: 疎通確認（common role・更新後）
  ansible.builtin.ping:
```

この状態で`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state）

Terraform will perform the following actions:

  # null_resource.provision must be replaced
-/+ resource "null_resource" "provision" {
      ~ id       = "6805260346048414665" -> (known after apply)
      ~ triggers = { # forces replacement
          ~ "playbook_hash" = "f4ac937b578661ca2b805819440374198a8defd35d438afb3cf1e9c3f9212c32" -> "e05b81a3369c956084a95fedaaf9c4bf44c6a3396006804ac995084fb9fd9134"
        }
    }

Plan: 1 to add, 0 to change, 1 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.provision: Destroying... [id=6805260346048414665]
null_resource.provision: Destruction complete after 0s
null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ansible-playbook -i inventory.ini site.yml"]

null_resource.provision (local-exec): PLAY [接続確認用Playbook] ******************************************************

null_resource.provision (local-exec): TASK [common : 疎通確認（common role・更新後）] ********************************
（途中省略：Pythonインタープリタ検出に関するWARNING）
null_resource.provision (local-exec): ok: [target-node3]
null_resource.provision (local-exec): ok: [target-node1]
null_resource.provision (local-exec): ok: [target-node2]

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
null_resource.provision (local-exec): target-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

null_resource.provision: Creation complete after 5s [id=1600380798870489971]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
```

### ■ 結果

`playbook_hash`の値が`f4ac937b...`から`e05b81a3...`へ変わり、`null_resource.provision`が再作成され、Ansible実行が走りました。`local-exec`のログのタスク名も`TASK [common : 疎通確認（common role・更新後）]`となっており、変更後の内容がそのまま実行されています。

`roles/common/tasks/main.yml`という、Role配下の1ファイルの変更が、`fileset`による結合ハッシュに反映され、`playbook_hash`全体の変化として検知されたことが確認できました。`site.yml`単体を対象にした`filesha256`（セクション3）では検知できない、複数ファイルにまたがる変更が、この構成で検知できることが実機で確認できました。

---

[↑ 目次に戻る](#-目次)

---



## 6. 検証環境での動作確認

ここまでのセクションで個別に確認した内容を、一連の流れとして振り返ります。

セクション3では`site.yml`単体を対象にした`filesha256`、セクション5では`roles`ディレクトリ配下の複数ファイルを対象にした`fileset`による構成を、それぞれ実機で確認しました。両方に共通していたのは、以下の流れです。
```

① triggersの計算方法を切り替えた直後のterraform apply  
　↓  
比較対象となる前回値がstateに存在しないため、無条件で再作成される  
　↓  
② Playbookを変更せずにterraform applyを再実行  
　↓  
ハッシュ値が前回と一致し、No changesとなる（Ansible実行はスキップされる）  
　↓  
③ Playbookの内容を変更してterraform applyを実行  
　↓  
ハッシュ値が変化し、再作成される（Ansible実行が走る）

```

セクション3（`filesha256`）、セクション5（`fileset`）のいずれも、②の時点で`Apply complete! Resources: 0 added, 0 changed, 0 destroyed`となり、`local-exec`のログが一切出力されないことを確認しました。一方、①と③では`null_resource.provision`が再作成され、`local-exec`によるAnsible実行（`ansible-playbook -i inventory.ini site.yml`の実行、target-node1〜3への疎通確認）が、そのつど走ることを確認しています。

この流れが示しているのは、`triggers`（`playbook_hash`）の値が変わるかどうかだけが、`null_resource.provision`の再作成、ひいてはAnsible実行の要否を決めているという点です。`docker_container.targets`をはじめとする他のリソースは、これらの検証を通じて一貫して作成計画に含まれておらず、`triggers`の値の変化だけを起点に、Ansible実行の有無が切り替わる構成になっていることが確認できました。

対象ファイルが単一（`site.yml`のみ）か、複数（`roles`配下）かによって、`triggers`に指定する式（`filesha256`か`fileset`の組み合わせか）は変わりますが、「ハッシュ値が変わらなければ再作成しない」という判定の仕組み自体は共通です。次のセクションでは、この`triggers`に何を含めるかという設計判断について整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. triggersに何を含めるかという設計判断

ここまでの検証は、いずれも「Playbookファイル本体（またはRole配下のタスクファイル）」だけを`triggers`の対象にしてきました。しかし実際の構成では、Playbookの他にも、インベントリファイルや変数ファイル（`group_vars`等）が存在します。このセクションでは、`triggers`に含める対象の範囲をどう設計するかを整理します。

|triggersの対象範囲|挙動|
|---|---|
|Playbookファイルのみ|inventoryやvariablesファイルの変更を検知できない|
|Playbook＋inventory＋variables全体|検知範囲は広がるが、無関係な変更（コメント修正等）でも再実行される|

対象範囲を狭くすると、`triggers`が拾わないファイルに変更があった場合、Ansible実行がスキップされてしまい、意図した変更が反映されないまま気づかずに運用を続けてしまう可能性があります。逆に対象範囲を広げすぎると、Playbookの実質的な処理内容とは無関係な変更（コメントの追記、空行の調整等）でも再作成が発生し、`triggers`を導入した目的である「無駄な実行を減らす」ことと矛盾する挙動が生まれます。

この検知範囲の広さと精度のトレードオフは、**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)** で扱った、HCL側の整形基準（`terraform fmt`）とAnsible側の基準（`ansible-lint`）が、互いを橋渡しする仕組みを持たず独立して評価されるという構造と関連します。**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)** では、生成元（HCL）と生成物（YAML）のどちらの基準に合わせて書くかという線引きが問題でした。今回の`triggers`の対象範囲も同様に、「Terraform側でどこまでの変更を検知すべきか」という線引きの問題であり、対象を広げるか狭めるかという判断そのものに、唯一の正解があるわけではありません。

また、この仕組みはあくまで実行の最適化であり、Ansible自体の冪等性（**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**）を代替するものではない点も明記しておきます。`triggers`が制御しているのは「Ansibleを実行するかどうか」であり、実行されたPlaybookそのものが複数回実行しても同じ結果になるかどうかは、`triggers`とは別の問題です。`triggers`によってAnsible実行がスキップされるのは、あくまでPlaybookの内容に変更がない場合に限られ、Playbook自体の冪等性が壊れている場合の対処にはなりません。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

* 従来の構成では、Playbookの内容が変わっていなくても`terraform apply`実行のたびにAnsibleがフル実行されていた
* `null_resource`の`triggers`引数は、指定した値の変化を検知してリソースを再作成する仕組みであり、`timestamp()`のように毎回変わる値を指定すると、その性質を利用して「常に再実行する」構成にもなることを実機で確認した
* `triggers`に`filesha256`でPlaybookファイルのハッシュ値を指定することで、ファイルの内容が変わらない限りハッシュ値も変わらず、`null_resource`が再作成されない、つまりAnsible実行がスキップされることを実機で確認した
* `triggers`の記述を切り替えた直後の`terraform apply`では、比較対象となる前回の値がstateに存在しないため、ハッシュ値の一致・不一致に関わらず無条件で再作成が発生する
* `terraform_data`は`null` providerを必要としないビルトインのリソースタイプであり、`triggers_replace`引数によって`null_resource`の`triggers`と同じ役割を果たせる
* `filesha256`は単一ファイル、`fileset`と組み合わせることで、Roleディレクトリ配下の複数ファイルにまたがる変更も1つのハッシュ値としてまとめて検知できることを実機で確認した
* `triggers`に含める対象範囲は、検知漏れ（対象を狭めた場合）と過剰検知（対象を広げた場合）のトレードオフであり、唯一の正解があるわけではない
* この仕組みはあくまで実行の最適化であり、Ansible自体の冪等性を代替するものではない

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** では、Terraformの責務を状態の出力に限定する疎結合設計への移行を扱い、**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** では、GitHub Actionsを用いたCI環境の構築によって、コンテナ起動からAnsible適用までのE2Eテストを扱いました。今回は、視点を変え、「Ansibleを実行するかどうか」という判断そのものをTerraform側の状態管理に組み込む設計を扱いました。`null_resource`の`triggers`引数にPlaybookファイルのハッシュ値を指定することで、内容に変更がない限りAnsible実行そのものをスキップできることを、単一ファイル・複数ファイルの両方のケースで実機検証を交えて確認しました。

次回は、Testinfraを用いてAnsible適用後の状態（ポート、ファイル、プロセス）を検証し、その結果をCI/CDパイプラインに組み込む設計を扱います。

**[次回：第34回：Testinfraによる状態検証を組込んだCI/CDパイプライン](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)　｜　[次の記事：【Ansible×Terraform編】第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)**

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

### 第4部：改善、CI/CD自動化編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)**|状態出力を介した疎結合なパイプライン設計|Terraformの`output`を中間データ（JSON/Environment）として抽出し、Ansibleの動的インベントリや変数として渡すパイプラインの分離設計。|
|**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)**|GitHub Actionsを用いたプロビジョニングコードの自動テスト環境構築|CI/CD（GitHub Actions）上でTerraform実行によるコンテナ起動からAnsible適用までの自動テスト（E2E）を組み込む手法。|
|**[第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)**|`triggers`を用いたAnsible再実行の最適化設計|`null_resource`や`terraform_data`の`triggers`／`triggers_replace`を使い、設定ファイル変更時のみAnsibleを発火させる設計。|
|**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)**|Testinfraによる状態検証を組込んだCI/CDパイプライン|Ansible適用後の状態（ポート、ファイル、プロセス）をTestinfra（Python）でテストし、パイプラインの成否を判定する自動化設計。|
|**[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)**|共通パーツのモジュール化（Terraformモジュール／Ansibleロール）|Terraformのモジュール設計とAnsibleのロール（Role/Collection）の粒度を揃え、再利用性を高める設計パターン。|
|**[第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)**|プラグインおよびパッケージのキャッシュによる開発効率の向上|Terraformのプラグインキャッシュとaptパッケージキャッシュにより、検証サイクルの待ち時間を短縮する手法。|
|**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)**|定期実行による構成ドリフトの自動検知と収束パイプライン|スケジュール実行（Cron／GitHub Actions）で`ansible-playbook --check`を流し、実際の構成差分（ドリフト）を検知し、差分があった場合のみ本実行して自動収束させる設計。|
|**[第38回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/)**|インフラコード（HCL／Playbook）からの仕様書、構成図の自動生成|`terraform-docs`や`ansible-autodoc`等を活用し、コード更新と同時に仕様書や依存関係図を自動更新するパイプライン構築。|
|**[第39回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/)**|既存インフラ運用知識とInfrastructure as Code（IaC）のシナジー|手動運用（CLI/Shell）のノウハウを、TerraformとAnsibleという2大ツールにどう分解、再構築していくかの比較考察。|
|**[第40回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/)**|改善、CI/CD編まとめ：プロビジョニング自動化の成熟度モデル|手動実行から状態連携、CI/CD化、自動収束（Level 1〜4）に至るまでのインフラ自動化の成熟度の整理。|                                                 |

---

[↑ 目次に戻る](#-目次)

---