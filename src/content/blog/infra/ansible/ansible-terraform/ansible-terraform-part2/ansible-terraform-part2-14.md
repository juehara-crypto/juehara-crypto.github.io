---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第14回：複数回実行時におけるAnsible Playbookの冪等性の確保'
description: 'terraform applyのlocal-exec経由でAnsibleが複数回実行される構成において、冪等性が確保されていないPlaybookがterraform apply自体の失敗を引き起こす構造を整理する。専用モジュールへの置き換え、実行条件の明示、--check --diffによる事前確認という設計パターンを理解する。'
pubDate: '2026-08-20'
category: 'infra'
tags: ['Ansible', 'Terraform', '冪等性', 'local-exec', '--check']
seriesId: 'ansible-terraform-part2'
seriesNo: 14
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [local-exec経由でのAnsible複数回実行の構造](#2-local-exec経由でのansible複数回実行の構造)
3. [冪等性の崩れがterraform apply失敗につながる構造](#3-冪等性の崩れがterraform-apply失敗につながる構造)
4. [リソース再生成後のAnsible再実行との連動](#4-リソース再生成後のansible再実行との連動)
5. [冪等性を確保する設計パターン](#5-冪等性を確保する設計パターン)
6. [terraform apply前の事前確認](#6-terraform-apply前の事前確認)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「`terraform apply`を再実行したら、前回は問題なく動いていたはずのAnsibleが急にエラーで止まった」という経験はないでしょうか。

前回、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** では、TerraformのHCL定義変更が「更新」で済むか「破棄、再生成」になるかを分ける判定構造を整理しました。`terraform plan`の出力にある`-/+`という記号と`# forces replacement`という注記が、この判定結果を`apply`前に示すこと、そして破棄、再生成が発生すればAnsibleが投入したOS内部の設定はすべて消失し、Ansibleを再実行しない限り復旧しないことを確認しています。

今回扱うのは、この「Ansibleを再実行する」という復旧の工程そのものが抱えるリスクです。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** の最後でも触れた通り、再生成後の復旧はAnsibleの再実行によって成り立ちますが、この再実行が安全に行えるかどうかは、Playbookの冪等性設計にかかっています。

具体的には、次のような場面です。

- コンテナ起動定義に軽微な修正を加えてterraform applyを再実行しただけなのに、local-exec内のAnsible実行がエラーで終了し、apply自体が失敗した
- 1回目の実行では問題なく完了したPlaybookが、2回目の実行でファイルの重複やディレクトリ作成の失敗を起こす
- Terraform側のリソース定義は変わっていないはずが、local-exec経由で毎回Ansibleが実行され、その都度何かが変わっていく

この事象の背景には、Terraformの構成にlocal-exec経由でAnsibleを呼び出す仕組みが組み込まれている場合の性質があります。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** で整理した第1部の処理フローでも、「⑥Terraformがlocal-execでAnsibleを呼び出す」という工程が組み込まれていました。この構成のもとでは、`terraform apply`を実行するたびにAnsibleも実行されることになります。「Ansibleは1回だけ実行されるもの」という前提は、この構成では成立しません。複数回実行されることを前提にPlaybookが設計されていなければ、2回目以降の実行のどこかで問題が表面化します。そしてlocal-execはAnsibleの実行結果をTerraformの実行結果に直結させる仕組みでもあるため、Ansible側の失敗はそのままterraform apply自体の失敗として記録されることになります。

この回では、「local-exec経由での複数回実行が、冪等性の崩れとどう連動してterraform apply失敗につながるか」という問いを軸に、この連鎖の構造を順番に整理します。まず次のセクションで、前提となるlocal-exec経由でのAnsible複数回実行の構造そのものを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. local-exec経由でのAnsible複数回実行の構造

この回の前提となる、local-execとAnsibleの関係を整理します。

Terraform×Ansible連携環境では、次のような構成が一般的です。

```hcl
resource "例示用リソース" "example" {
  # ...
  provisioner "local-exec" {
    command = "ansible-playbook -i inventory.ini playbook.yml"
  }
}
```

`local-exec`はTerraformのプロビジョナーの1つで、指定したコマンドをローカル環境（Terraformを実行しているコントロールノード）で実行する仕組みです。この構成では、`ansible-playbook`コマンドがそのままリソース定義の一部として組み込まれています。

ここで確認しておきたいのは、この`local-exec`が実行されるタイミングです。`provisioner`ブロックは、対象のリソースが作成される、またはリソース定義に変更が加わり`apply`が実行されるたびに、その一連の処理の中で呼び出されます。つまり、このリソースを初めて作成したときだけでなく、コード修正によって`terraform apply`を再実行するたびに、`local-exec`経由でPlaybookが実行される構成になっています。

これは、リソースの初回作成時に1度だけAnsibleを実行するつもりで書いたコードであっても、その後のコード修正、再実行のたびに同じPlaybookが繰り返し実行されるということを意味します。

「Ansibleは1回だけ実行されるもの」という前提は、この`local-exec`経由の構成では成立しません。`terraform apply`を実行する回数だけ、Playbookも実行される構成になっています。

この構造そのものは、Playbookの内容が冪等であれば問題になりません。しかし、Playbookのタスクが冪等でない場合、この「複数回実行される」という構造が、次のセクションで整理する問題につながります。

---

[↑ 目次に戻る](#-目次)

---

## 3. 冪等性の崩れがterraform apply失敗につながる構造

この回の核心となる、AnsibleとTerraformの実行結果の連動構造を整理します。

`local-exec`は内部で実行したコマンドの終了コードを見ています。`ansible-playbook`がタスク失敗で終了コード0以外を返すと、`local-exec`が失敗としてTerraformに伝わり、`terraform apply`自体が失敗としてログに記録される構造になっています。

ここで明確にしておきたい前提として、`command`・`shell`モジュール自体は状態確認をせず、無条件にコマンドを実行します。問題が起きるかどうかは、実行するコマンド自体がOSレベルで冪等な動作をするかどうかに依存します **（※1）**。

冪等でないコマンドが2回目の実行で失敗するケースとして、`command: mkdir /etc/myapp_demo`のように、2回目の実行時に既にディレクトリが存在し、`mkdir`コマンド自体が「File exists」エラーを返して終了コード非0になるケースを扱います。

この連鎖を、以下の手順で実機確認します。

```plaintext
mkdirを含むPlaybookをlocal-exec経由で初回実行する
　↓
正常に完了することを確認する
　↓
コンテナ自体には変更を加えず、null_resourceのtriggersのみを変化させて
terraform applyを再実行する
　↓
local-exec内でansible-playbookがmkdirの「File exists」エラーで失敗し
terraform apply自体がエラーで終了することをログで確認する
```

### ■ 検証内容（local-exec経由でAnsibleが複数回実行される構成で、冪等でないコマンドが2回目の実行でterraform apply自体を失敗させることの確認）

検証には、`docker_container.targets`とは独立した`null_resource`を新規に用意し、`variable`の値の変化を`triggers`として`local-exec`経由でPlaybookを再実行させる構成を使用します。この構成にすることで、コンテナ自体の再生成とは無関係に、「Ansibleが複数回実行される」という構造だけを切り出して確認できます。

* **ファイル名：**`main.tf`（該当箇所のみ抜粋）

```hcl
variable "ansible_provision_trigger" {
  type    = string
  default = "v1"
}

resource "null_resource" "mkdir_idempotency_demo" {
  triggers = {
    demo_version = var.ansible_provision_trigger
  }

  provisioner "local-exec" {
    command = "ansible-playbook -i ../docker-lab/inventory.ini ../ansible/playbooks/test_mkdir_idempotency.yml"
  }

  depends_on = [docker_container.targets, local_file.ansible_inventory]
}
```

検証用のPlaybookは、target-node1のみを対象に、冪等でない`command`モジュールで`mkdir`を実行する内容にしました。

* **ファイル名：**`playbooks/test_mkdir_idempotency.yml`

```yaml
---
- name: mkdirの冪等性崩壊デモ（target-node1のみ）
  hosts: target-node1
  become: true
  gather_facts: false
  tasks:
    - name: 検証用ディレクトリを作成する（冪等でないコマンド）
      ansible.builtin.command: mkdir /etc/myapp_demo
```

#### 1回目の実行

`variable`のデフォルト値`"v1"`のまま`terraform apply`を実行し、`null_resource.mkdir_idempotency_demo`が初回実行されます。

**▼ 実行結果**

```plaintext
null_resource.mkdir_idempotency_demo: Creating...
null_resource.mkdir_idempotency_demo: Provisioning with 'local-exec'...
null_resource.mkdir_idempotency_demo (local-exec): Executing: ["/bin/sh" "-c" "ansible-playbook -i ../docker-lab/inventory.ini ../ansible/playbooks/test_mkdir_idempotency.yml"]

null_resource.mkdir_idempotency_demo (local-exec): PLAY [mkdirの冪等性崩壊デモ（target-node1のみ）] *******************************

null_resource.mkdir_idempotency_demo (local-exec): TASK [検証用ディレクトリを作成する（冪等でないコマンド）] **********************
null_resource.mkdir_idempotency_demo (local-exec): [WARNING]: Platform linux on host target-node1 is using the discovered Python
null_resource.mkdir_idempotency_demo (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.mkdir_idempotency_demo (local-exec): interpreter could change the meaning of that path. See
null_resource.mkdir_idempotency_demo (local-exec): https://docs.ansible.com/ansible-
null_resource.mkdir_idempotency_demo (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.mkdir_idempotency_demo (local-exec): changed: [target-node1]

null_resource.mkdir_idempotency_demo (local-exec): PLAY RECAP *********************************************************************
null_resource.mkdir_idempotency_demo (local-exec): target-node1               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

null_resource.mkdir_idempotency_demo: Creation complete after 4s [id=2628840294288911157]

Apply complete! Resources: 5 added, 0 changed, 1 destroyed.
```

`changed=1`となり、`mkdir /etc/myapp_demo`が正常に完了しています。この時点でtarget-node1に`/etc/myapp_demo`が実際に作成されたことを確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 ls -ld /etc/myapp_demo
```

**▼ 実行結果**

```plaintext
drwxr-xr-x 2 root root 4096 Aug 20 04:36 /etc/myapp_demo
```

ディレクトリが作成されていることが確認できました。この状態を起点に、2回目の実行を行います。

#### 2回目の実行

`docker_container.targets`のコンテナ自体には一切変更を加えず、`variable "ansible_provision_trigger"`のデフォルト値のみを`"v1"`から`"v2"`に変更します。

```hcl
variable "ansible_provision_trigger" {
  type    = string
  default = "v2"
}
```

この状態で`terraform plan`を実行します。

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # null_resource.mkdir_idempotency_demo must be replaced
-/+ resource "null_resource" "mkdir_idempotency_demo" {
      ~ id       = "2628840294288911157" -> (known after apply)
      ~ triggers = { # forces replacement
          ~ "demo_version" = "v1" -> "v2"
        }
    }

Plan: 1 to add, 0 to change, 1 to destroy.
```

`docker_container.targets`には差分が出ておらず、`null_resource.mkdir_idempotency_demo`のみが`triggers`の変化により再作成対象になっていることが確認できます。この状態で`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
null_resource.mkdir_idempotency_demo: Destroying... [id=2628840294288911157]
null_resource.mkdir_idempotency_demo: Destruction complete after 0s
null_resource.mkdir_idempotency_demo: Creating...
null_resource.mkdir_idempotency_demo: Provisioning with 'local-exec'...
null_resource.mkdir_idempotency_demo (local-exec): Executing: ["/bin/sh" "-c" "ansible-playbook -i ../docker-lab/inventory.ini ../ansible/playbooks/test_mkdir_idempotency.yml"]

null_resource.mkdir_idempotency_demo (local-exec): PLAY [mkdirの冪等性崩壊デモ（target-node1のみ）] *******************************

null_resource.mkdir_idempotency_demo (local-exec): TASK [検証用ディレクトリを作成する（冪等でないコマンド）] **********************
null_resource.mkdir_idempotency_demo (local-exec): [WARNING]: Platform linux on host target-node1 is using the discovered Python
null_resource.mkdir_idempotency_demo (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.mkdir_idempotency_demo (local-exec): interpreter could change the meaning of that path. See
null_resource.mkdir_idempotency_demo (local-exec): https://docs.ansible.com/ansible-
null_resource.mkdir_idempotency_demo (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.mkdir_idempotency_demo (local-exec): fatal: [target-node1]: FAILED! => {"ansible_facts": {"discovered_interpreter_python": "/usr/bin/python3.10"}, "changed": true, "cmd": ["mkdir", "/etc/myapp_demo"], "delta": "0:00:00.004635", "end": "2026-08-20 05:15:05.472958", "msg": "non-zero return code", "rc": 1, "start": "2026-08-20 05:15:05.468323", "stderr": "mkdir: cannot create directory ‘/etc/myapp_demo’: File exists", "stderr_lines": ["mkdir: cannot create directory ‘/etc/myapp_demo’: File exists"], "stdout": "", "stdout_lines": []}

null_resource.mkdir_idempotency_demo (local-exec): PLAY RECAP *********************************************************************
null_resource.mkdir_idempotency_demo (local-exec): target-node1               : ok=0    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0

╷
│ Error: local-exec provisioner error
│
│   with null_resource.mkdir_idempotency_demo,
│   on main.tf line 118, in resource "null_resource" "mkdir_idempotency_demo":
│  118:   provisioner "local-exec" {
│
│ Error running command 'ansible-playbook -i ../docker-lab/inventory.ini ../ansible/playbooks/test_mkdir_idempotency.yml': exit status 2. Output:
│ PLAY [mkdirの冪等性崩壊デモ（target-node1のみ）] *******************************
│
│ TASK [検証用ディレクトリを作成する（冪等でないコマンド）] **********************
│ [WARNING]: Platform linux on host target-node1 is using the discovered Python
│ interpreter at /usr/bin/python3.10, but future installation of another Python
│ interpreter could change the meaning of that path. See
│ https://docs.ansible.com/ansible-
│ core/2.17/reference_appendices/interpreter_discovery.html for more information.
│ fatal: [target-node1]: FAILED! => {"ansible_facts": {"discovered_interpreter_python": "/usr/bin/python3.10"}, "changed": true, "cmd": ["mkdir", "/etc/myapp_demo"], "delta":
│ "0:00:00.004635", "end": "2026-08-20 05:15:05.472958", "msg": "non-zero return code", "rc": 1, "start": "2026-08-20 05:15:05.468323", "stderr": "mkdir: cannot create directory
│ ‘/etc/myapp_demo’: File exists", "stderr_lines": ["mkdir: cannot create directory ‘/etc/myapp_demo’: File exists"], "stdout": "", "stdout_lines": []}
│
│ PLAY RECAP *********************************************************************
│ target-node1               : ok=0    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
│
│
╵
```

`ansible-playbook`が「File exists」エラーで失敗し、その結果`local-exec provisioner error`として`terraform apply`自体がエラーで終了しました。エラーメッセージの`Output:`以降には、`local-exec`が捕捉した`ansible-playbook`の標準出力がそのまま再掲されており、直前の実行ログと重複する内容になっています。

### ■ 結果

`triggers`の値の変化だけをきっかけに、`docker_container.targets`側には一切変更を加えず、`null_resource.mkdir_idempotency_demo`のみを再実行させたところ、`local-exec`内の`ansible-playbook`が実際に失敗しました。1回目の実行で作成された`/etc/myapp_demo`が2回目の実行時にも存在していたため、`mkdir`（`-p`なし）が「File exists」エラーを返し、Ansible側のタスクは`failed=1`で終了しています。

この失敗が、そのまま`terraform apply`自体のエラーとして記録されました。

ここで確認しておきたいのは、この失敗の発生条件です。今回の検証では、`docker_container.targets`のコンテナ自体には何の変更も加えていません。変化したのは`null_resource.mkdir_idempotency_demo`の`triggers`の値だけであり、これによって`local-exec`が再実行されるという構造だけが働いています。つまり、この失敗はリソースの再生成とは無関係に、「`local-exec`経由でAnsibleが複数回実行される」という構造だけで発生しています。

`command`モジュールは、実行前にディレクトリの存在を確認しません。1回目の実行時点では`/etc/myapp_demo`は存在せず、`mkdir`は問題なく成功しました。しかし2回目の実行時点では、1回目の実行によってそのディレクトリがすでに存在しています。`command`モジュールはこの状態の違いを一切考慮せず、同じコマンドをそのまま実行するため、2回目は必然的にエラーになります。

この結果から、`local-exec`経由でAnsibleが複数回実行される構成では、Playbookが冪等でない限り、初回は成功しても、2回目以降のどこかで必ず失敗するタイミングが訪れることが確認できました。そしてこの失敗は、Ansible側の失敗にとどまらず、`terraform apply`自体の失敗としてそのまま記録されます。`local-exec`はAnsibleの実行結果をTerraformの実行結果に直結させる仕組みであるため、Playbook側の冪等性の崩れが、インフラ層の操作であるはずの`terraform apply`の成否にまで影響を及ぼす構造になっています。

---

> **※1 参考資料**
> 
> OSが返す終了ステータス（exit code）を、Ansibleがどのような仕組みで「成功」「失敗」と判定しているかについては、以下のシリーズで詳しく扱っています。
> 
> → **[Ansibleが理解できない理由はLinuxにあった【Shell編】第6回：なぜ条件分岐が失敗するのか（Exit Code）](https://qiita.com/juehara-crypto/items/b9f3f94c7e22e735eb00)**

---

[↑ 目次に戻る](#-目次)

---

## 4. リソース再生成後のAnsible再実行との連動

第13回で整理したリソース再生成のケースに、冪等性の崩れがどう連動するかを整理します。

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** では、`terraform plan`で`force_new_resource`を確認した後、`terraform apply`を実行し、target-node1が破棄、再生成された結果、Ansibleが投入した`/etc/app.conf`が消失することを確認しました。この消失を復旧するには、Ansibleの再実行が必要です。

ここでセクション3の結果を思い出します。セクション3では、`docker_container.targets`のコンテナ自体には一切変更を加えず、`null_resource`の`triggers`だけを変化させることで、`local-exec`経由のAnsible実行を単独で再実行させました。その結果、1回目は成功したPlaybookが、2回目の実行で`mkdir`の「File exists」エラーにより失敗し、`terraform apply`自体がエラーで終了することを確認しています。

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** のリソース再生成は、この「Ansibleが複数回実行される」という条件を満たす、もう1つのきっかけです。再生成が発生すれば、復旧のためにAnsibleを再実行する必要があります。このとき使うPlaybookが冪等でなければ、セクション3で確認したのと同じ理屈で、この再実行自体が失敗する可能性があります。

具体的には、以下の2つのケースが考えられます。

### 冪等でないコマンドを含むPlaybookの場合

セクション3で使った`test_mkdir_idempotency.yml`のようなPlaybookを、リソース再生成後の復旧に使う場面を考えます。再生成直後のコンテナは、初期化処理（`upload`ブロック等）を除いて中身が空の状態です。この状態でPlaybookを1回目に実行する分には、`mkdir`は問題なく成功します。

しかし、この復旧作業がやり直しになるケースがあります。例えば、Ansible側のタスクの一部が別の理由（ネットワーク瞬断、他のタスクの失敗など）で中断し、同じPlaybookをもう一度実行し直す場合です。あるいは、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** で確認したように、`terraform apply`の再実行自体が、コード修正のたびに繰り返される構成になっている場合です。こうした場面では、リソースは再生成されていない、つまりコンテナの中身は前回投入したままの状態で、Playbookだけが再度実行されることになります。この場合、セクション3で確認したのと全く同じ構造で、`mkdir`は「File exists」エラーを返し、復旧作業自体が失敗します。

つまり、リソース再生成という現象は、Ansible再実行を「必要」にする側の要因であり、その再実行が「安全に行えるかどうか」は、リソースが再生成されたかどうかとは独立して、Playbookの冪等性設計にかかっています。

### `lineinfile`のmarker省略による重複の場合

`mkdir`のような即座に失敗するケースだけでなく、実行は成功するものの内容が壊れていくケースもあります。`lineinfile`でファイルの一部を編集するPlaybookを考えます。

`lineinfile`は、`insertafter`・`insertbefore`のみで挿入位置を指定し、`marker`を明示していない場合、既存の挿入内容を「自分が過去に挿入した行」として認識できません。そのため、同じタスクを複数回実行すると、同じ内容の行がその都度追加されていく可能性があります **（※2）** 。

再生成直後のコンテナに対してこのタスクを1回実行しただけでは、この問題は表面化しません。しかし、`terraform apply`の再実行のたびにPlaybookが繰り返し流れる構成では、このタスクも同じ回数だけ実行されることになります。1回ごとの実行は`changed`として正常に完了するため、Ansible側のログだけを見ていると異常には見えません。しかし、対象ファイルの中身は、実行のたびに同じ行が増えていく状態になります。

このケースが`mkdir`のケースと異なるのは、失敗が即座に表面化しない点です。`terraform apply`はエラーにならず成功し続けるため、この重複はファイルの中身を直接確認しない限り気づかれません。冪等性の崩れが必ずしも`terraform apply`の失敗として現れるとは限らず、気づかれないままファイルの状態が壊れていくケースもあるという点が、ここで押さえておきたい構造です。

### 再生成とapply再実行の共通点

リソース再生成による復旧作業と、通常の`terraform apply`再実行によるPlaybookの繰り返し実行は、発生のきっかけこそ異なりますが、「Ansibleが同じPlaybookを複数回実行する」という点では同じ構造の問題です。前者はリソースが新品に戻った状態からの複数回実行であり、後者はリソースの中身がそのまま残った状態での複数回実行という違いはありますが、いずれもPlaybookが冪等でなければ、2回目以降のどこかで問題が発生するという結論は変わりません。

---

> **※2 参考資料**
> 
> `lineinfile`が`marker`を明示していない場合に、なぜ重複した行が追加されてしまうのかについては、以下のシリーズで実機検証を交えて詳しく扱っています。
> 
> → **[「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第6回：なぜlineinfileは"安全そうに見えて危険"なのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/)**

---

[↑ 目次に戻る](#-目次)

---

## 5. 冪等性を確保する設計パターン

セクション3、4で示した問題に対する設計パターンを整理します。

### ファイル操作の冪等性確保

ファイル全体を管理する場合は`template`、`copy`モジュールを使います。複数回実行しても同じ結果になるため、`local-exec`経由での繰り返し実行に対しても安全です。

`lineinfile`を使う場合は、`marker`を明示します。セクション4で確認した通り、`marker`を省略すると、`insertafter`・`insertbefore`だけでは「自分が過去に挿入した行」を認識できず、実行のたびに同じ内容の行が追加されていく可能性があります。`marker`を指定しておけば、`lineinfile`はその目印で囲まれた範囲を自分の管理対象として認識し、2回目以降は既存の挿入内容を書き換えるだけで、行が増え続けることはありません。

### 専用モジュールへの置き換え

`mkdir`相当の処理は、`command`ではなく`file`モジュール（`state: directory`）に置き換えます。`file`モジュールは対象が既に存在する状態を正しく認識し、2回目の実行でもエラーを返しません。

セクション3で使った`test_mkdir_idempotency.yml`の`command`タスクを、`file`モジュールに置き換えて実機で確認します。

* **ファイル名：**`playbooks/test_mkdir_idempotent_fixed.yml`

```yaml
---
- name: mkdirの冪等性確保デモ（fileモジュール版）
  hosts: target-node1
  become: true
  gather_facts: false
  tasks:
    - name: 検証用ディレクトリを作成する（冪等なモジュール）
      ansible.builtin.file:
        path: /etc/myapp_demo
        state: directory
```

target-node1の`/etc/myapp_demo`を一度削除した状態から、このPlaybookを2回連続で実行します。

**実行コマンド**

```plaintext
ansible-playbook -i ../docker-lab/inventory.ini playbooks/test_mkdir_idempotent_fixed.yml
```

**▼ 1回目の実行結果**

```plaintext
PLAY [mkdirの冪等性確保デモ（fileモジュール版）] ********************************************************************************************************************************************
TASK [検証用ディレクトリを作成する（冪等なモジュール）] *************************************************************************************************************************************
changed: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**▼ 2回目の実行結果**

```plaintext
PLAY [mkdirの冪等性確保デモ（fileモジュール版）] ********************************************************************************************************************************************
TASK [検証用ディレクトリを作成する（冪等なモジュール）] *************************************************************************************************************************************
ok: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

1回目は`changed=1`となり、ディレクトリが存在しなかったため新規作成されています。2回目は`changed=0`となり、`file`モジュールが「既に対象が存在する」ことを確認した上で、何も操作していません。セクション3で確認した`command`モジュール版が2回目に「File exists」エラーで失敗したのに対し、`file`モジュールに置き換えるだけで、同じ操作が2回目以降も安全に実行できる状態になっています。

### command、shellを使わざるを得ない場合の対処

専用モジュールが存在しない処理で`command`、`shell`を使う場合は、`creates`オプションまたは`when`条件で実行条件を明示し、コマンド自体の非冪等性をAnsible側で吸収します。

target-node1の初期セットアップ処理を模した例で確認します。

* **ファイル名：**`playbooks/test_creates_idempotent.yml`

```yaml
---
- name: creates指定による冪等性確保デモ
  hosts: target-node1
  become: true
  gather_facts: false
  tasks:
    - name: アプリケーションの初期セットアップを実行する
      ansible.builtin.command: touch /etc/myapp_demo/.setup_completed
      args:
        creates: /etc/myapp_demo/.setup_completed
```

**実行コマンド**

```plaintext
ansible-playbook -i ../docker-lab/inventory.ini playbooks/test_creates_idempotent.yml
```

**▼ 1回目の実行結果**

```plaintext
PLAY [creates指定による冪等性確保デモ] ******************************************************************************************************************************************************
TASK [アプリケーションの初期セットアップを実行する] *****************************************************************************************************************************************
changed: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**▼ 2回目の実行結果**

```plaintext
PLAY [creates指定による冪等性確保デモ] ******************************************************************************************************************************************************
TASK [アプリケーションの初期セットアップを実行する] *****************************************************************************************************************************************
ok: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

1回目は`changed=1`となり、`.setup_completed`ファイルが存在しなかったためコマンドが実行されています。2回目は`changed=0`となっていますが、これは`file`モジュールのように現在の状態を観測した結果ではありません。`creates`に指定したパスが既に存在する時点で、Ansibleはこのタスク自体の実行をスキップしています。`command`モジュール自体は相変わらず状態を観測できませんが、`creates`という外部の目印を判断材料として設計者側が与えることで、タスクの実行有無を制御しています。

`when`条件を使う場合も考え方は同じです。`stat`モジュールで対象の現在状態を取得し、その結果を`when`条件に使うことで、`command`、`shell`の実行有無を制御できます **（※3）**。専用モジュールが存在しない処理であっても、その周囲に「実行すべき状態かどうか」を判断する構造を設計者が持ち込むことで、`command`、`shell`モジュール自体を冪等にするのではなく、冪等に近い動作を実現しています。

---

> **※3 参考資料**
> 
> `creates`、`stat`＋`when`、`register`＋`changed_when`という3つのパターンの詳細と、それぞれの使い分けについては、以下のシリーズで整理しています。
> 
> → **[「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第10回：「冪等に設計する」とは何を設計することなのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-10/)**

---

[↑ 目次に戻る](#-目次)

---

## 6. terraform apply前の事前確認

`terraform apply`の実行前に、Playbookの冪等性の崩れを事前に検出できるかを確認します。

`ansible-playbook`には`--check`モードがあります。`--diff`と組み合わせることで、実際の変更を加えずに、実行した場合何が変わるかを事前に確認できます。

```plaintext
ansible-playbook --check --diff playbook.yml
```

この`--check --diff`を、セクション3で使った`command`版（`test_mkdir_idempotency.yml`）と、セクション5で直した`file`版（`test_mkdir_idempotent_fixed.yml`）の両方に対して実行し、事前確認としてどこまで機能するかを確認します。

### ■ 検証内容（`--check --diff`が、冪等でないタスクと冪等なタスクをそれぞれどう扱うかの確認）

target-node1には、セクション5の検証によって`/etc/myapp_demo`が既に存在する状態です。この状態のまま、それぞれのPlaybookに`--check --diff`を実行します。

**実行コマンド**

```plaintext
ansible-playbook -i ../docker-lab/inventory.ini playbooks/test_mkdir_idempotency.yml --check --diff
```

**▼ 実行結果**

```
PLAY [mkdirの冪等性崩壊デモ（target-node1のみ）] ********************************************************************************************************************************************
TASK [検証用ディレクトリを作成する（冪等でないコマンド）] ***********************************************************************************************************************************
skipping: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=0    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

**実行コマンド**

```plaintext
ansible-playbook -i ../docker-lab/inventory.ini playbooks/test_mkdir_idempotent_fixed.yml --check --diff
```

**▼ 実行結果**

```plaintext
PLAY [mkdirの冪等性確保デモ（fileモジュール版）] ********************************************************************************************************************************************
TASK [検証用ディレクトリを作成する（冪等なモジュール）] *************************************************************************************************************************************
ok: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

`command`版と`file`版で、`--check --diff`の結果に明確な違いが出ました。

`command`版は`skipping`と表示され、`skipped=1`として集計されています。`command`、`shell`モジュールは、デフォルトで`--check`モード時にタスク自体がスキップされます **（※4）** 。実際にコマンドを実行していないため、対象ディレクトリが既に存在するかどうかも確認されておらず、「File exists」エラーが起きるかどうかも判定されていません。この結果だけを見ると`changed=0`であり、一見問題がないように見えますが、これは「差分がなかった」ことを意味するのではなく、「タスクが実行されなかった」ことを意味しています。

`file`版は`ok`と表示され、`changed=0`となっています。`file`モジュールは`--check`モードでも実際に対象の現在状態を観測し、「既に`state: directory`の条件を満たしている」と判定した上で、変更不要という結果を返しています。こちらは実態を反映した`changed=0`です。

この対比から分かるのは、`--check --diff`で`changed=0`という結果が出たとしても、それが「実際に観測した結果としての差分なし」なのか、「そもそも確認されていないタスクの結果」なのかは、モジュールの種類によって異なるという点です。`command`、`shell`モジュールを含むPlaybookに対して`--check --diff`を実行し、エラーが出なかったとしても、それは冪等性が確認されたことを意味しません。`terraform apply`前の事前確認としては、Playbook内に`command`、`shell`モジュールが含まれていないか、含まれている場合はその実行結果が`--check`では検証されないという前提を踏まえた上で運用する必要があります。

問題がない、あるいは`command`、`shell`モジュールが専用モジュールに置き換えられていることを確認できた場合にのみ、`terraform apply`を実行するという運用が、この回で整理してきた冪等性の崩れによる`apply`失敗のリスクを事前に下げる手段になります。

---

> **※4 参考資料**
> 
> `--check`モードが確認できる範囲と確認できない範囲の全体像については、以下のシリーズで整理しています。
> 
> → **[「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第9回：冪等性はどうやって検証すべきなのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-09/)**

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* `local-exec`経由でAnsibleが実行される構成では、`terraform apply`を実行するたびにPlaybookが複数回実行される。「Ansibleは1回だけ実行されるもの」という前提は、この構成では成立しない
* `command`、`shell`モジュール自体は状態確認をせず無条件に実行する。問題が起きるかどうかは、実行するコマンド自体がOSレベルで冪等かどうかに依存する。冪等でないコマンド（`mkdir`等）は2回目以降の実行で失敗し、その失敗はそのまま`terraform apply`自体の失敗につながる
* この失敗は、コンテナ自体の再生成とは無関係に、`local-exec`の複数回実行という構造だけで発生する。一方、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** で扱ったリソース再生成後の復旧作業も、同じく「Ansibleの複数回実行」という構造を持つため、Playbookが冪等でなければ同様の問題が起こり得る。特に`lineinfile`のmarker省略による重複は、`terraform apply`自体を失敗させないまま、ファイルの状態だけが気づかれずに壊れていく点に注意が必要である
* 専用モジュール（`file`等）への置き換えと、`creates`、`when`による実行条件の明示が、冪等性確保の基本パターンになる
* `terraform apply`前に`--check --diff`を実行する運用は有効だが、`command`、`shell`モジュールは`--check`モード時にタスク自体がスキップされるため、この確認だけでは非冪等なタスクを検出できない。`--check --diff`で問題が出なかったことは、冪等性が確認されたことを意味しない

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** では、TerraformのHCL定義変更が「更新」で済むケースと「破棄、再生成」になるケースを分ける判定構造を整理し、破棄、再生成が発生した際にAnsibleが投入した設定が消失する様子を確認しました。

今回はその先を扱い、この消失を復旧する側であるAnsible Playbookの複数回実行に焦点を移しました。`local-exec`経由の構成では`terraform apply`のたびにPlaybookが実行される構造そのものと、冪等性が確保されていないPlaybookが`terraform apply`自体を失敗させる様子を実機で確認しました。あわせて、専用モジュールへの置き換えによる設計パターン、`terraform apply`前の`--check --diff`による事前確認と、その確認手段自体が持つ限界も整理しました。

次回は、視点を単一環境から複数人での運用に移します。ここまでは1人がTerraformとAnsibleの両方を操作する前提で進めてきましたが、実際の運用ではAnsibleを実行するオペレーターと、Terraformを管理するエンジニアが分かれていることも珍しくありません。この場合、Terraformの状態管理ファイル（tfstate）に競合が発生するリスクが生じます。

**[次回：第15回：チーム運用における状態管理ファイル（tfstate）の整合性維持](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)　｜　[次の記事：【Ansible×Terraform編】第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第2部：運用・ライフサイクル編

|回数|テーマ・記事タイトル|概要|
|---|---|---|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**|手動変更による構成ドリフトの検知と同期手法|構築後に手動やAnsibleで変更したOS内部の状態を、Terraformの`plan`が検知できず、インフラの管理状態に不整合が出る問題。ドリフトシリーズとの接続を示す。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**|`terraform apply`実行時における初期化処理とOS設定の上書き問題|Terraform側で初期化スクリプトやコンテナ起動定義を書き換えて再実行した際、Ansibleによって設定済みのOS内部状態が初期化される課題。|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**|コード修正に伴うリソースの強制再生成（リビルド）リスク|TerraformのHCL定義変更によって、リソースが「更新」ではなく「破棄、再生成」され、Ansibleが投入した内部データが消失する課題。|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**|複数回実行時におけるAnsible Playbookの冪等性の確保|`terraform apply`のlocal-exec経由でAnsibleが複数回実行される構成において、冪等性が確保されていないPlaybookがterraform apply自体の失敗を引き起こす問題。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**|チーム運用における状態管理ファイル（tfstate）の整合性維持|Ansibleを実行するオペレーターと、Terraformを管理するエンジニア間で、Terraformの状態管理ファイルに競合が発生するリスク。チーム運用での役割分担設計も整理する。|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**|パッケージアップデートに伴う環境の非互換性への対応|運用中に`apt update`等を実行した結果、OSのライブラリやミドルウェアのバージョンが上がり、Terraformの定義と矛盾が生じるケース。|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)**|リソース再生成時におけるIPアドレス変動と接続情報の更新遅延|リソース（コンテナ/VM）の再生成に伴ってIPアドレスが変更された際、Ansible用のインベントリや各種設定ファイルの書き換えが追いつかない問題。|
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)**|TerraformとAnsible Vaultにおける機密情報の役割分担|データベースのパスワードやAPIキーなどの機密情報を、両ツールのどちらで暗号化し、どのように管理すべきかの運用設計。Vault誤用パターンと回避策も整理する。|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)**|OSのメジャーバージョンアップ時におけるPlaybookの互換性検証|Terraform側でベースイメージ（例：Ubuntu 22.04→24.04）を変更した際、Ansibleの古い独自モジュールやシェルコマンドが機能しなくなる課題。|
|第20回|運用編まとめ：ミュータブル運用とイミュータブル運用の折衷案|状態（データ）を維持し続ける運用（ミュータブル）と、使い捨てる運用（イミュータブル）を、両ツールの組み合わせでどのように着地させるかの最適解。|

---

[↑ 目次に戻る](#-目次)

---
