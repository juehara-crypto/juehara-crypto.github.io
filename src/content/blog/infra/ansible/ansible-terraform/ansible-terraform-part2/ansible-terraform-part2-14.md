---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第14回：local-execで再実行されたAnsibleが失敗し、terraform applyが止まる理由―冪等でないcommand（mkdir）と、--check --diffでは検出できない限界'
description: 'local-execでAnsibleを呼び出す構成では、冪等でないPlaybookが2回目の実行で失敗し、terraform apply自体の失敗として記録される。再実行される条件、専用モジュールへの置き換え、実行条件の明示、--check --diffによる事前確認とその限界を理解する。'
pubDate: '2026-08-20'
category: 'infra'
tags: ['Ansible', 'Terraform', '冪等性', 'local-exec', 'triggers', 'forces replacement', '--check']
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
> → **[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題](https://qiita.com/juehara-crypto/items/c3e95e3bec11e07bbe75)**

---

> **🔍 今起きている症状・課題から、読むべき回を探したい方はこちら**
>
> 全50回で扱った症状・課題を、部をまたいで1か所に集めた逆引きリファレンスがあります。
> 症状・課題の一覧から原因の見当をつけ、該当する回のセクションまでたどれます。
>
> → **[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」逆引きリファレンス：全50回の症状・課題を5つの図から引く](https://qiita.com/juehara-crypto/items/bd2832993ef887e8022a)**

---

**※本記事の位置とシリーズ全体の関係を先に確認します。**

---

## 📍 本記事の位置

````mermaid
graph TD
    Main["統合ブログ<br/>シリーズ全体のナビゲーション"]

    subgraph Parts [各部のまとめブログ　全5本]
        Part1["第1部まとめブログ<br/>環境構築、連携編"]
        Part2["第2部まとめブログ<br/>運用、ライフサイクル編"]
        Part3["第3部まとめブログ<br/>トラブルシューティング、デバッグ編"]
        Part4["第4部まとめブログ<br/>改善、CI/CD自動化編"]
        Part5["第5部まとめブログ<br/>Terraformライフサイクル破壊編"]
    end

    subgraph Articles [各回ブログ　全50本]
        Part1_Detail["第1回〜第10回"]
        Part2_Detail["第11回〜第20回"]
        Part3_Detail["第21回〜第30回"]
        Part4_Detail["第31回〜第40回"]
        Part5_Detail["第41回〜第50回"]
    end

    Reverse["逆引きリファレンス<br/>全50回の症状・課題を集約"]

    Main --- Part1
    Main --- Part2
    Main --- Part3
    Main --- Part4
    Main --- Part5

    Part1 --- Part1_Detail
    Part2 --- Part2_Detail
    Part3 --- Part3_Detail
    Part4 --- Part4_Detail
    Part5 --- Part5_Detail

    Part1_Detail --- Reverse
    Part2_Detail --- Reverse
    Part3_Detail --- Reverse
    Part4_Detail --- Reverse
    Part5_Detail --- Reverse

    style Main fill:#e1f5fe,stroke:#01579b,stroke-width:3px
    style Part2_Detail fill:#fff3e0,stroke:#e65100,stroke-width:3px
    style Parts fill:none
    style Articles fill:none
````

本シリーズは、**[統合ブログ](https://qiita.com/juehara-crypto/items/5bd6720b7aaed13757f8)**、第1〜5部のまとめブログ（全5本）、第1〜50回の各回ブログ（全50本）の3階層で構成されています。**現在はこの図の下段、第2部「第11回〜第20回」のうちの第14回になります。** 統合ブログとまとめブログは、シリーズを上から順に読み進めるための入口です。

また、この3階層とは別に、**[逆引きリファレンス](https://qiita.com/juehara-crypto/items/bd2832993ef887e8022a)** があります。第1〜50回の各回ブログで扱った症状・課題を、部をまたいで1か所に集め、今起きている症状や解決したい課題から、該当する回へ直接たどり着けるようにしたものです。

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

「コードを少し修正して`terraform apply`を実行したら、前回は問題なく動いていたはずのAnsibleが急にエラーで止まった」という経験はないでしょうか。

前回、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** では、TerraformのHCL定義変更が「更新」で済むか「破棄、再生成」になるかを分ける判定構造を整理しました。`terraform plan`の出力にある`-/+`という記号と`# forces replacement`という注記が、この判定結果を`apply`前に示すこと、そして破棄、再生成が発生すればAnsibleが投入したOS内部の設定はすべて消失し、Ansibleを再実行しない限り復旧しないことを確認しています。

今回扱うのは、この「Ansibleを再実行する」という復旧の工程そのものが抱えるリスクです。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** の最後でも触れた通り、再生成後の復旧はAnsibleの再実行によって成り立ちますが、この再実行が安全に行えるかどうかは、Playbookの冪等性設計にかかっています。

具体的には、次のような場面です。

- local-execでAnsibleを呼び出しているリソースが再作成されたところ、local-exec内のAnsible実行がエラーで終了し、terraform apply自体が失敗した
- 1回目の実行では問題なく完了したPlaybookが、2回目の実行でファイルの重複やディレクトリ作成の失敗を起こす
- Terraform側のリソース定義は変わっていないはずが、local-exec経由でAnsibleが再実行されるたびに、その都度何かが変わっていく

この事象の背景には、Terraformの構成にlocal-exec経由でAnsibleを呼び出す仕組みが組み込まれている場合の性質があります。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** で整理した第1部の処理フローでも、「⑥Terraformがlocal-execでAnsibleを呼び出す」という工程が組み込まれていました。この構成のもとでは、local-execを持つリソースが作成されるたびにAnsibleも実行されます。再作成も作成にあたるため、`triggers`の変更やリソースの再生成のたびに、同じPlaybookが繰り返し実行されることになります。「Ansibleは1回だけ実行されるもの」という前提は、この構成では成立しません。複数回実行されることを前提にPlaybookが設計されていなければ、2回目以降の実行のどこかで問題が表面化します。そしてlocal-execはAnsibleの実行結果をTerraformの実行結果に直結させる仕組みでもあるため、Ansible側の失敗はそのままterraform apply自体の失敗として記録されることになります。

この回では、「local-exec経由での複数回実行が、冪等性の崩れとどう連動してterraform apply失敗につながるか」という問いを軸に、この連鎖の構造を順番に整理します。まず次のセクションで、前提となるlocal-exec経由でのAnsible複数回実行の構造そのものを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. local-exec経由でのAnsible複数回実行の構造

この回の前提となる、local-execとAnsibleの関係を整理します。

Terraform×Ansible連携環境では、次のような構成が一般的です。

````hcl
resource "例示用リソース" "example" {
  # ...
  provisioner "local-exec" {
    command = "ansible-playbook -i inventory.ini playbook.yml"
  }
}
````

`local-exec`はTerraformのプロビジョナーの1つで、指定したコマンドをローカル環境（Terraformを実行しているコントロールノード）で実行する仕組みです。この構成では、`ansible-playbook`コマンドがそのままリソース定義の一部として組み込まれています。

ここで確認しておきたいのは、この`local-exec`が実行されるタイミングです。`provisioner`ブロックは、そのリソースが作成されるときに実行されます。変更のない`terraform apply`では、リソースは作成されないため、`local-exec`も実行されません。一方、リソースの再作成も作成にあたるため、`triggers`の値が変わった場合や、リソースの属性変更で`forces replacement`となった場合には、再作成のたびに`local-exec`経由でPlaybookが実行されます。`triggers`の変更で再作成になる様子は、セクション3の`terraform plan`の出力で確認します。リソースの属性変更が更新で済むか再生成になるかは、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** で整理した通り、`terraform plan`の`~`と`-/+`で`apply`前に判別できます。

これは、リソースの初回作成時に1度だけAnsibleを実行するつもりで書いたコードであっても、その後のコード修正で再作成が発生するたびに、同じPlaybookが繰り返し実行されるということを意味します。

「Ansibleは1回だけ実行されるもの」という前提は、この`local-exec`経由の構成では成立しません。リソースが再作成される回数だけ、Playbookも実行される構成になっています。

この構造そのものは、Playbookの内容が冪等であれば問題になりません。しかし、Playbookのタスクが冪等でない場合、この「複数回実行される」という構造が、次のセクションで整理する問題につながります。

---

[↑ 目次に戻る](#-目次)

---

## 3. 冪等性の崩れがterraform apply失敗につながる構造

この回の核心となる、AnsibleとTerraformの実行結果の連動構造を整理します。

`local-exec`は内部で実行したコマンドの終了コードを見ています。`ansible-playbook`がタスク失敗で終了コード0以外を返すと、`local-exec`が失敗としてTerraformに伝わり、`terraform apply`自体が失敗としてログに記録される構造になっています。

ここで明確にしておきたい前提として、`command`、`shell`モジュール自体は状態確認をせず、無条件にコマンドを実行します。問題が起きるかどうかは、実行するコマンド自体がOSレベルで冪等な動作をするかどうかに依存します **（※1）**。

冪等でないコマンドが2回目の実行で失敗するケースとして、`command: mkdir /etc/myapp_demo`のように、2回目の実行時に既にディレクトリが存在し、`mkdir`コマンド自体が「File exists」エラーを返して終了コード非0になるケースを扱います。

この連鎖を、以下の手順で実機確認します。

````plaintext
mkdirを含むPlaybookをlocal-exec経由で初回実行する
　↓
正常に完了することを確認する
　↓
コンテナ自体には変更を加えず、null_resourceのtriggersのみを変化させて
terraform applyを再実行する
　↓
local-exec内でansible-playbookがmkdirの「File exists」エラーで失敗し
terraform apply自体がエラーで終了することをログで確認する
````

### ■ 検証内容（local-exec経由でAnsibleが複数回実行される構成で、冪等でないコマンドが2回目の実行でterraform apply自体を失敗させることの確認）

検証には、`docker_container.targets`とは独立した`null_resource`を新規に用意し、`variable`の値の変化を`triggers`として`local-exec`経由でPlaybookを再実行させる構成を使用します。この構成にすることで、コンテナ自体の再生成とは無関係に、「Ansibleが複数回実行される」という構造だけを切り出して確認できます。

* **ファイル名：**`main.tf`（該当箇所のみ抜粋）

````hcl
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
````

検証用のPlaybookは、target-node1のみを対象に、冪等でない`command`モジュールで`mkdir`を実行する内容にしました。

* **ファイル名：**`playbooks/test_mkdir_idempotency.yml`

````yaml
---
- name: mkdirの冪等性崩壊デモ（target-node1のみ）
  hosts: target-node1
  become: true
  gather_facts: false
  tasks:
    - name: 検証用ディレクトリを作成する（冪等でないコマンド）
      ansible.builtin.command: mkdir /etc/myapp_demo
````

#### 1回目の実行

`variable`のデフォルト値`"v1"`のまま`terraform apply`を実行し、`null_resource.mkdir_idempotency_demo`が初回実行されます。

**実行コマンド**

````plaintext
terraform apply
````

**▼ 実行結果**

````plaintext
（…target-node1〜3のコンテナの作成と、local_file.ansible_inventoryの置き換えのログは省略…）

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
````

`Apply complete! Resources: 5 added, 0 changed, 1 destroyed.`の内訳は、target-node1〜3のコンテナ3台の作成、`local_file.ansible_inventory`の置き換え（破棄と作成）、`null_resource.mkdir_idempotency_demo`の作成です。この`apply`の時点では、検証環境にコンテナが存在していませんでした。

`changed=1`となり、`mkdir /etc/myapp_demo`が正常に完了しています。この時点でtarget-node1に`/etc/myapp_demo`が実際に作成されたことを確認します。

**実行コマンド**

````plaintext
docker exec -it target-node1 ls -ld /etc/myapp_demo
````

**▼ 実行結果**

````plaintext
drwxr-xr-x 2 root root 4096 Aug 20 04:36 /etc/myapp_demo
````

ディレクトリが作成されていることが確認できました。この状態を起点に、2回目の実行を行います。

#### 2回目の実行

`docker_container.targets`のコンテナ自体には一切変更を加えず、`variable "ansible_provision_trigger"`のデフォルト値のみを`"v1"`から`"v2"`に変更します。

````hcl
variable "ansible_provision_trigger" {
  type    = string
  default = "v2"
}
````

この状態で`terraform plan`を実行します。

**実行コマンド**

````plaintext
terraform plan
````

**▼ 実行結果**

````plaintext
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
````

`docker_container.targets`には差分が出ておらず、`null_resource.mkdir_idempotency_demo`のみが`triggers`の変化により再作成対象になっていることが確認できます。この状態で`terraform apply`を実行します。

**実行コマンド**

````plaintext
terraform apply
````

**▼ 実行結果**

````plaintext
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
````

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

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** で整理したリソース再生成のケースに、冪等性の崩れがどう連動するかを整理します。

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** では、`terraform plan`で`# forces replacement`の注記を確認した後、`terraform apply`を実行し、target-node1が破棄、再生成された結果、Ansibleが投入した`/etc/app.conf`が消失することを確認しました。この消失を復旧するには、Ansibleの再実行が必要です。

ここでセクション3の結果を思い出します。セクション3では、`docker_container.targets`のコンテナ自体には一切変更を加えず、`null_resource`の`triggers`だけを変化させることで、`local-exec`経由のAnsible実行を単独で再実行させました。その結果、1回目は成功したPlaybookが、2回目の実行で`mkdir`の「File exists」エラーにより失敗し、`terraform apply`自体がエラーで終了することを確認しています。

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** の検証環境では、コンテナが再生成されても`local-exec`を持つ`null_resource.provision`は再作成されず、Ansibleは自動では再実行されませんでした。そのため、再生成が発生すれば、復旧のためにAnsibleを再実行する必要があります。この再実行も、「Ansibleが複数回実行される」もう1つのきっかけです。

具体的には、以下の2つのケースが考えられます。

### 冪等でないコマンドを含むPlaybookの場合

セクション3で使った`test_mkdir_idempotency.yml`のようなPlaybookを、リソース再生成後の復旧に使う場面を考えます。再生成直後のコンテナは、イメージと初期化処理（`upload`ブロック等）の内容だけがあり、Ansibleが投入した内容は含まれていない状態です。この状態でPlaybookを1回目に実行する分には、`mkdir`は問題なく成功します。

しかし、この復旧作業がやり直しになるケースがあります。例えば、Ansible側のタスクの一部が別の理由（ネットワーク瞬断、他のタスクの失敗など）で中断し、同じPlaybookをもう一度実行し直す場合です。あるいは、セクション3で確認したように、`triggers`の変更などで`local-exec`を持つリソースだけが再作成される場合です。こうした場面では、コンテナは再生成されていない、つまりコンテナの中身は前回投入したままの状態で、Playbookだけが再度実行されることになります。この場合、セクション3で確認したのと全く同じ構造で、`mkdir`は「File exists」エラーを返し、復旧作業自体が失敗します。

つまり、リソース再生成という現象は、Ansible再実行を「必要」にする側の要因であり、その再実行が「安全に行えるかどうか」は、リソースが再生成されたかどうかとは独立して、Playbookの冪等性設計にかかっています。

### `lineinfile`の`regexp`不一致による重複の場合

`mkdir`のような即座に失敗するケースだけでなく、実行は成功するものの内容が壊れていくケースもあります。`lineinfile`でファイルの一部を編集するPlaybookを考えます。

`lineinfile`は、`regexp`に一致する行がない場合、`line`の内容をファイルの末尾に追加します。`regexp`が対象の行と一致しない書き方（インデントの違いなど）になっていると、元の行が残ったまま、別の行が追加されて共存する状態になります **（※2）**。

このタスクは`changed`として正常に完了するため、Ansible側のログだけを見ていると異常には見えません。しかし、`local-exec`を持つリソースの再作成のたびにPlaybookが流れる構成では、元の行と追加された行が共存した状態のファイルが、そのまま運用に使われ続けることになります。どちらの設定が有効になるかは、アプリケーション側の解釈に依存します。

このケースが`mkdir`のケースと異なるのは、失敗が即座に表面化しない点です。`terraform apply`はエラーにならず成功し続けるため、この重複はファイルの中身を直接確認しない限り気づかれません。冪等性の崩れが必ずしも`terraform apply`の失敗として現れるとは限らず、気づかれないままファイルの状態が壊れていくケースもあるという点が、ここで押さえておきたい構造です。

### 再生成とlocal-exec再実行の共通点

リソース再生成による復旧作業と、`triggers`の変更による`local-exec`の再実行は、発生のきっかけこそ異なりますが、「Ansibleが同じPlaybookを複数回実行する」という点では同じ構造の問題です。前者はリソースが新品に戻った状態からの複数回実行であり、後者はリソースの中身がそのまま残った状態での複数回実行という違いはありますが、いずれもPlaybookが冪等でなければ、2回目以降のどこかで問題が発生するという結論は変わりません。

---

> **※2 参考資料**
> 
> `lineinfile`の`regexp`が一致しない場合に、なぜ元の行が残ったまま別の行が追加されてしまうのかについては、以下のシリーズで実機検証を交えて詳しく扱っています。
> 
> → **[「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第6回：なぜlineinfileは"安全そうに見えて危険"なのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/)**

---

[↑ 目次に戻る](#-目次)

---

## 5. 冪等性を確保する設計パターン

セクション3、4で示した問題に対する設計パターンを整理します。

### ファイル操作の冪等性確保

ファイル全体を管理する場合は`template`、`copy`モジュールを使います。複数回実行しても同じ結果になるため、`local-exec`経由での繰り返し実行に対しても安全です。

`lineinfile`を使う場合は、`regexp`で対象の行を正確に特定します。セクション4で確認した通り、`regexp`が対象の行と一致しないと、元の行が残ったまま別の行が追加されます。`regexp`を、行頭の空白なども含めて実際の行に一致する形で指定しておけば、`lineinfile`は既存の行を書き換えるだけで、元の行と追加行が共存する状態にはなりません。

### 専用モジュールへの置き換え

`mkdir`相当の処理は、`command`ではなく`file`モジュール（`state: directory`）に置き換えます。`file`モジュールは対象が既に存在する状態を正しく認識し、2回目の実行でもエラーを返しません。

セクション3で使った`test_mkdir_idempotency.yml`の`command`タスクを、`file`モジュールに置き換えて実機で確認します。

* **ファイル名：**`playbooks/test_mkdir_idempotent_fixed.yml`

````yaml
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
````

target-node1の`/etc/myapp_demo`を一度削除した状態から、このPlaybookを2回連続で実行します。

**実行コマンド**

````plaintext
ansible-playbook -i ../docker-lab/inventory.ini playbooks/test_mkdir_idempotent_fixed.yml
````

**▼ 1回目の実行結果**

````plaintext
PLAY [mkdirの冪等性確保デモ（fileモジュール版）] ********************************************************************************************************************************************
TASK [検証用ディレクトリを作成する（冪等なモジュール）] *************************************************************************************************************************************
changed: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
````

**▼ 2回目の実行結果**

````plaintext
PLAY [mkdirの冪等性確保デモ（fileモジュール版）] ********************************************************************************************************************************************
TASK [検証用ディレクトリを作成する（冪等なモジュール）] *************************************************************************************************************************************
ok: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
````

1回目は`changed=1`となり、ディレクトリが存在しなかったため新規作成されています。2回目は`changed=0`となり、`file`モジュールが「既に対象が存在する」ことを確認した上で、何も操作していません。セクション3で確認した`command`モジュール版が2回目に「File exists」エラーで失敗したのに対し、`file`モジュールに置き換えるだけで、同じ操作が2回目以降も安全に実行できる状態になっています。

### command、shellを使わざるを得ない場合の対処

専用モジュールが存在しない処理で`command`、`shell`を使う場合は、`creates`オプションまたは`when`条件で実行条件を明示し、コマンド自体の非冪等性をAnsible側で吸収します。

target-node1の初期セットアップ処理を模した例で確認します。

* **ファイル名：**`playbooks/test_creates_idempotent.yml`

````yaml
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
````

**実行コマンド**

````plaintext
ansible-playbook -i ../docker-lab/inventory.ini playbooks/test_creates_idempotent.yml
````

**▼ 1回目の実行結果**

````plaintext
PLAY [creates指定による冪等性確保デモ] ******************************************************************************************************************************************************
TASK [アプリケーションの初期セットアップを実行する] *****************************************************************************************************************************************
changed: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
````

**▼ 2回目の実行結果**

````plaintext
PLAY [creates指定による冪等性確保デモ] ******************************************************************************************************************************************************
TASK [アプリケーションの初期セットアップを実行する] *****************************************************************************************************************************************
ok: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
````

1回目は`changed=1`となり、`.setup_completed`ファイルが存在しなかったためコマンドが実行されています。2回目は`changed=0`となっていますが、これは`file`モジュールのように現在の状態を観測した結果ではありません。`creates`に指定したパスが既に存在する時点で、Ansibleはコマンドを実行せず、結果を`ok`として返しています（セクション6の`--check`での`skipping`とは別の扱いです）。`command`モジュール自体は相変わらず状態を観測できませんが、`creates`という外部の目印を判断材料として設計者側が与えることで、タスクの実行有無を制御しています。

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

````plaintext
ansible-playbook --check --diff playbook.yml
````

この`--check --diff`を、セクション3で使った`command`版（`test_mkdir_idempotency.yml`）と、セクション5で直した`file`版（`test_mkdir_idempotent_fixed.yml`）の両方に対して実行し、事前確認としてどこまで機能するかを確認します。

### ■ 検証内容（`--check --diff`が、冪等でないタスクと冪等なタスクをそれぞれどう扱うかの確認）

target-node1には、セクション5の検証によって`/etc/myapp_demo`が既に存在する状態です。この状態のまま、それぞれのPlaybookに`--check --diff`を実行します。

**実行コマンド**

````plaintext
ansible-playbook -i ../docker-lab/inventory.ini playbooks/test_mkdir_idempotency.yml --check --diff
````

**▼ 実行結果**

````
PLAY [mkdirの冪等性崩壊デモ（target-node1のみ）] ********************************************************************************************************************************************
TASK [検証用ディレクトリを作成する（冪等でないコマンド）] ***********************************************************************************************************************************
skipping: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=0    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
````

**実行コマンド**

````plaintext
ansible-playbook -i ../docker-lab/inventory.ini playbooks/test_mkdir_idempotent_fixed.yml --check --diff
````

**▼ 実行結果**

````plaintext
PLAY [mkdirの冪等性確保デモ（fileモジュール版）] ********************************************************************************************************************************************
TASK [検証用ディレクトリを作成する（冪等なモジュール）] *************************************************************************************************************************************
ok: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
````

### ■ 結果

`command`版と`file`版で、`--check --diff`の結果に明確な違いが出ました。

`command`版は`skipping`と表示され、`skipped=1`として集計されています。実行条件（`creates`、`removes`）を持たない`command`、`shell`モジュールは、デフォルトで`--check`モード時にタスク自体がスキップされます **（※4）**。実際にコマンドを実行していないため、対象ディレクトリが既に存在するかどうかも確認されておらず、「File exists」エラーが起きるかどうかも判定されていません。この結果だけを見ると`changed=0`であり、一見問題がないように見えますが、これは「差分がなかった」ことを意味するのではなく、「タスクが実行されなかった」ことを意味しています。

`file`版は`ok`と表示され、`changed=0`となっています。`file`モジュールは`--check`モードでも実際に対象の現在状態を観測し、「既に`state: directory`の条件を満たしている」と判定した上で、変更不要という結果を返しています。こちらは実態を反映した`changed=0`です。

以下は検証用の別ホスト（verify14-node1）で取得したログです。`/tmp/verify14_creates.yml`は、セクション5の`test_creates_idempotent.yml`と`hosts`だけが異なるPlaybookです。`creates`に指定したパスが存在する状態にしてから実行しました。

**実行コマンド**

````plaintext
ansible-playbook -i /tmp/inventory_verify14.ini /tmp/verify14_creates.yml --check --diff
````

**▼ 実行結果**

````plaintext
PLAY [creates指定による冪等性確保デモ] ******************************************************************************************************************************************************

TASK [アプリケーションの初期セットアップを実行する] *****************************************************************************************************************************************
[WARNING]: Platform linux on host verify14-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [verify14-node1]

PLAY RECAP **********************************************************************************************************************************************************************************
verify14-node1             : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
````

なお、セクション5の`test_creates_idempotent.yml`のように`creates`を指定した`command`は、`--check`でもその条件が評価され、`ok`と表示されました。スキップされるのは、`creates`や`removes`のような実行条件を持たない`command`、`shell`のタスクです。ただし、この`ok`も、`creates`で指定したパスの有無を見ただけの結果です。コマンド自体が冪等かどうかを確認したわけではありません。

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

* `local-exec`経由でAnsibleが実行される構成では、`local-exec`を持つリソースが作成、再作成されるたびにPlaybookが実行される。`triggers`の変更や、`local-exec`を持つリソース自体の再生成でも再実行されるため、「Ansibleは1回だけ実行されるもの」という前提は、この構成では成立しない
* `command`、`shell`モジュール自体は状態確認をせず無条件に実行する。問題が起きるかどうかは、実行するコマンド自体がOSレベルで冪等かどうかに依存する。冪等でないコマンド（`mkdir`等）は2回目以降の実行で失敗し、その失敗はそのまま`terraform apply`自体の失敗につながる
* この失敗は、コンテナ自体の再生成とは無関係に、`local-exec`の複数回実行という構造だけで発生する。一方、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** で扱ったリソース再生成後の復旧作業も、同じく「Ansibleの複数回実行」という構造を持つため、Playbookが冪等でなければ同様の問題が起こり得る。特に`lineinfile`の`regexp`不一致による行の重複は、`terraform apply`自体を失敗させないまま、ファイルの状態だけが気づかれずに壊れていく点に注意が必要である
* 専用モジュール（`file`等）への置き換えと、`creates`、`when`による実行条件の明示が、冪等性確保の基本パターンになる
* `terraform apply`前に`--check --diff`を実行する運用は有効だが、実行条件（`creates`等）を持たない`command`、`shell`のタスクは`--check`モード時にスキップされるため、この確認だけでは非冪等なタスクを検出できない。`--check --diff`で問題が出なかったことは、冪等性が確認されたことを意味しない

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** では、TerraformのHCL定義変更が「更新」で済むケースと「破棄、再生成」になるケースを分ける判定構造を整理し、破棄、再生成が発生した際にAnsibleが投入した設定が消失する様子を確認しました。

今回はその先を扱い、この消失を復旧する側であるAnsible Playbookの複数回実行に焦点を移しました。`local-exec`経由の構成ではリソースの再作成のたびにPlaybookが実行される構造そのものと、冪等性が確保されていないPlaybookが`terraform apply`自体を失敗させる様子を実機で確認しました。あわせて、専用モジュールへの置き換えによる設計パターン、`terraform apply`前の`--check --diff`による事前確認と、その確認手段自体が持つ限界も整理しました。

次回は、視点を単一環境から複数人での運用に移します。ここまでは1人がTerraformとAnsibleの両方を操作する前提で進めてきましたが、実際の運用では、複数人がそれぞれの作業ディレクトリから`terraform apply`を実行したり、Ansible担当がTerraformの出力を参照したりすることがあります。この場合、tfstateの記録が上書きで消えたり、Terraform側の出力名の変更だけでAnsible側のスクリプトが止まったりするリスクが生じます。

**[次回：第15回：複数人が別々のディレクトリでterraform applyしたtfstateを上書きすると記録が消え、出力名の変更だけでAnsibleのスクリプトも止まる理由](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)　｜　[次の記事：【Ansible×Terraform編】第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題](https://qiita.com/juehara-crypto/items/c3e95e3bec11e07bbe75)**

---

> **🔍 今起きている症状・課題から、読むべき回を探したい方はこちら**
>
> 全50回で扱った症状・課題を、部をまたいで1か所に集めた逆引きリファレンスがあります。
> 症状・課題の一覧から原因の見当をつけ、該当する回のセクションまでたどれます。
>
> → **[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」逆引きリファレンス：全50回の症状・課題を5つの図から引く](https://qiita.com/juehara-crypto/items/bd2832993ef887e8022a)**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第2部：運用、ライフサイクル編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**|Terraformのplanが、手動やAnsibleによるOS内部の変更を検知できない理由―tfstateの管理範囲と、--check --diffによる補完|構築後に手動やAnsibleで変更したOS内部の状態は、tfstateの管理範囲の外にあるため、Terraformの`plan`では検知できない。Ansibleの`--check --diff`による補完と、インフラ層、OS層を二軸で確認、同期する手順を整理する。ドリフトシリーズとの接続を示す。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**|初期化スクリプト・コンテナ起動定義を変更してterraform applyを再実行すると、コンテナが作り直されてAnsibleの設定が消える理由―uploadブロックのforces replacementと、初期化処理とAnsibleの役割分離|初期化スクリプトやコンテナ起動定義の変更で`forces replacement`が発生し、リソースが破棄、再生成されて、Ansibleが設定済みのOS内部状態が消える課題。初期化処理とAnsibleの役割分離で消失の影響を小さくする設計を整理する。|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**|HCLの1行の変更でコンテナが破棄、再生成され、Ansibleの設定が消える理由―更新と再生成の分かれ目と、terraform planの「-/+」「forces replacement」による事前判定|HCLの1行の変更でも、属性によっては「更新」ではなく「破棄、再生成」となり、Ansibleが投入した設定が消える。`terraform plan`の`~`と`-/+`、`forces replacement`の注記から、`apply`前に再生成を見分ける方法を整理する。|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**|local-execで再実行されたAnsibleが失敗し、terraform applyが止まる理由―冪等でないcommand（mkdir）と、--check --diffでは検出できない限界|`local-exec`経由でAnsibleが複数回実行される構成で、冪等でないPlaybookが2回目の実行で失敗し、`terraform apply`自体の失敗につながる問題。専用モジュールへの置き換えと、`--check --diff`では検出できない限界を整理する。冪等性シリーズ、レガシーPlaybook引き継ぎの知識を実践に適用する回として位置づける。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**|複数人が別々のディレクトリでterraform applyしたtfstateを上書きすると記録が消え、出力名の変更だけでAnsibleのスクリプトも止まる理由―state lockingの守備範囲と、中間ファイルによる分離|複数人が別々のディレクトリで扱ったtfstateを上書きすると記録が消える問題と、Ansible担当がtfstateを直接参照すると、出力名の変更だけでスクリプトが止まる問題。state lockingの守備範囲と、中間ファイルによる分離、apply実行権限の設計を整理する。|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**|apt update／apt upgradeでパッケージが更新されると、バージョンを前提にしたAnsible Playbookが失敗する理由―Terraformのイメージ固定の範囲外と、aptモジュールでのバージョン指定|運用中に`apt update`、`apt upgrade`でパッケージが更新されると、バージョンを前提にしたAnsible Playbookが失敗する問題。Terraformのイメージ固定が及ばない範囲と、`apt`モジュールでのバージョン指定による制御を整理する。|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)**|リソースの再生成でIPアドレスが変わると、静的インベントリのままではAnsibleがUNREACHABLEになる理由―動的インベントリで追従できる範囲と、DNS・hostsなど追従できない参照|リソースの再生成でIPアドレスが変わると、書き換えていない静的インベントリではAnsibleが`UNREACHABLE`になる問題。動的インベントリで追従できる範囲と、DNSや`/etc/hosts`など追従できない参照を整理する。|
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)**|sensitive = trueを指定してもtfstateにパスワードが平文で残る理由―Ansible Vaultとの責務分担と、Vaultの誤用パターン|`sensitive = true`を指定しても、`output`の値がtfstateに平文で残る問題。TerraformとAnsible Vaultの責務分担と、Vaultの誤用パターンと回避策を整理する。|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)**|ベースイメージをUbuntu 22.04から24.04に切り替えると、ansible_python_interpreterでPython 3.10を固定したPlaybookがnot foundで失敗する理由―自動検出との違いと、/etc/apt/sources.listの形式変更|ベースイメージをUbuntu 22.04から24.04に切り替えると、`ansible_python_interpreter`をパスで固定したPlaybookが`not found`で失敗する問題。自動検出との違いと、`/etc/apt/sources.list`の形式変更、標準モジュールの抽象化の限界を整理する。|
|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-20/)**|運用編まとめ：第11〜19回のトラブルは、リソースを直し続ける運用と作り直す運用のどちらで起きるか―ステートフルならミュータブル、ステートレスならイミュータブルという使い分け|第11〜19回のトラブルを、リソースを直し続けるミュータブル運用と、作り直すイミュータブル運用の軸で整理する。ステートフルならミュータブル、ステートレスならイミュータブルという使い分けを着地点として示す。|

---

[↑ 目次に戻る](#-目次)

---
