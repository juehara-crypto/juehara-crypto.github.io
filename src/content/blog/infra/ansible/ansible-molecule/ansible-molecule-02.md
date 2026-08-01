---
title: '「AnsibleのPlaybookが壊れる理由はテスト文化にあった」 第2回：冪等性テストを自動化する'
description: '冪等性シリーズで作成したPlaybookをMoleculeでテストする構成を実機で確認し、1回目と2回目の実行で何が確認されているかを読み取る。idempotencyフェーズで`changed`が発生した場合の表示を意図的に再現し、テストが失敗するとはどういう状態かを理解する。'
pubDate: '2026-08-01'
category: 'infra'
tags: ['Ansible', '構成管理', 'Molecule', '冪等性計', 'テスト', 'converge', 'idempotency']
seriesId: 'ansible-molecule'
seriesNo: 2
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-01/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-03/'
relatedSeries: ''
---


> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleのPlaybookが壊れる理由はテスト文化にあった」 シリーズまとめブログ** **※近日公開予定**

---

## 目次
1. [はじめに](#1-はじめに)
2. [対象プレイブックの構成](#2-対象プレイブックの構成)
3. [この回のスコープ：何を確認するか](#3-この回のスコープ何を確認するか)
4. [テストプロジェクトの構成を確認する](#4-テストプロジェクトの構成を確認する)
5. [実行結果を読む：正常系の出力](#5-実行結果を読む正常系の出力)
6. [冪等性違反を意図的に再現する：異常系の出力](#6-冪等性違反を意図的に再現する異常系の出力)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleのPlaybookが壊れる理由はテスト文化にあった」](#9-連載一覧ansibleのplaybookが壊れる理由はテスト文化にあった)

---

## 1. はじめに

**[第1回](http://localhost:4321/blog/infra/ansible/ansible-molecule/ansible-molecule-01/)** では、Moleculeの5フェーズ(create・converge・idempotency・verify・destroy)が何を確認しているかを、手動確認の手順と対応づけて構造として整理しました。

今回はその構造を実際に動かして確認します。冪等性シリーズで作成したプレイブックを対象に、Moleculeを実行し、出力から何が読み取れるかを見ていきます。「フェーズの構造を理解した」を「出力として読める」に進める回です。

なお、今回実機で確認するのは5フェーズすべてではなく、converge・idempotenceの2つが中心になります。理由はセクション3で整理します。

---

[↑ 目次に戻る](#目次)

---

## 2. 対象プレイブックの構成

この回で対象にするプレイブックは、冪等性シリーズで使用したものをそのまま使います。新たにテスト用のプレイブックを用意するのではなく、既存のプレイブックがテストの対象になるという位置づけです。

```yaml
---
- name: Configure nginx worker settings
  hosts: nodes
  become: true
  gather_facts: false
  vars:
    nginx_worker_connections: 768

  tasks:
    - name: nginx.confをtemplateで配置する
      ansible.builtin.template:
        src: ../templates/nginx.conf.j2
        dest: /etc/nginx/nginx.conf
        owner: root
        group: root
        mode: '0644'
      notify: reload nginx

  handlers:
    - name: reload nginx
      ansible.builtin.systemd:
        name: nginx
        state: reloaded
```

対象ノードは、`inventory.ini`に登録されている`nodes`グループに属する3台です。以降のセクションでは、この3台に対してテストを実行した結果を示します。

---

[↑ 目次に戻る](#目次)

---

## 3. この回のスコープ：何を確認するか

第1回で整理した5フェーズのうち、今回実機で確認するのはconverge・idempotenceの2つです。create・destroyはこの回では扱いません。その理由を整理します。

この回で確認したいのは、「同一プレイブックを連続実行した際に、2回目が変更なし(changed=0)になること」です。

createが担っているのは、テスト用のクリーンな環境から始めることで、1回目の実行が正真正銘の初回適用であることを保証する役割です。この役割は、初回適用そのものの挙動を厳密に確認したいテストにおいて重要になります。

今回のテーマは2回目の実行結果、つまりidempotenceに重点を置いています。そのため、この回では「同じ状態に対して再実行した際に不要な変更が発生しないか」を確認します。1回目の実行が完全な初回適用であることを保証することは、この回で確認したい内容には含めていません。

destroyが担っているのは、そのテストで使った環境を次のテストへ持ち越さない役割です。この役割は、複数のテストサイクルを互いに独立させたいテストにおいて重要になります。今回のように1回のサイクルを示すだけであれば、この独立性も確認したい内容には含めていません。create・destroyが不要な環境だからではなく、この回で確認したい内容がその範囲を必要としない、というのが理由です。

この回では、「プレイブックが何度実行しても不要な変更を発生させないこと」を確認することを目的とします。この目的に沿って、以降はconverge・idempotenceの2つのフェーズを中心に実機の出力を確認していきます。

---

[↑ 目次に戻る](#目次)

---

## 4. テストプロジェクトの構成を確認する

プロジェクトの構成は以下の通りです。設定ファイルの全項目は説明せず、「何のためのファイルか」が分かる程度にとどめます。

```
molecule/
└── default/
    ├── molecule.yml   # 対象ノードとテストの流れの設定
    └── converge.yml   # プレイブックを実行するエントリーポイント
```

`molecule.yml`の内容は以下の通りです。

**ファイル名：`molecule.yml`**

```yaml
dependency:
  name: galaxy

driver:
  name: default

platforms:
  - name: ubuntu-node1
  - name: ubuntu-node2
  - name: ubuntu-node3

provisioner:
  name: ansible
  inventory:
    links:
      hosts: ../../inventory/inventory.ini
  playbooks:
    converge: converge.yml

verifier:
  name: ansible
```

`driver`は初期状態のまま変更していません。変更したのは、テスト対象を指す`platforms`と、既存のインベントリを参照させる`provisioner.inventory`だけです。

`converge.yml`は、既存のプレイブックを呼び出す一行だけの構成にしています。

**ファイル名：`converge.yml`**

```yaml
---
- name: Converge
  import_playbook: ../../playbooks/configure_nginx.yml
```

セクション3で整理した通り、この回ではcreate・destroyを扱いません。そのため、`molecule.yml`にもcreate・destroy用のプレイブックは設定していません。

---

[↑ 目次に戻る](#目次)

---

## 5. 実行結果を読む：正常系の出力

convergeフェーズを実行します。

* **`converge`実行**

```
(ansible-env) control@ubuntu-controller:~/iac/ansible$ molecule converge
INFO     default ➜ discovery: scenario test matrix: dependency, create, prepare, converge
INFO     default ➜ prerun: Performing prerun with role_name_check=0...
INFO     default ➜ dependency: Executing
WARNING  default ➜ dependency: Missing roles requirements file: requirements.yml
WARNING  default ➜ dependency: Missing collections requirements file: collections.yml
WARNING  default ➜ dependency: Executed: 2 missing (Remove from converge_sequence to suppress)
INFO     default ➜ create: Executing
WARNING  default ➜ create: Executed: Missing playbook (Remove from converge_sequence to suppress)
INFO     default ➜ prepare: Executing
WARNING  default ➜ prepare: Executed: Missing playbook (Remove from converge_sequence to suppress)
INFO     default ➜ converge: Executing
  ┌──────────────────────────────────────────────────────────────────────────────────
  │ ansible-playbook --inventory /home/control/.ansible/tmp/molecule.DLh_.default/inventory
  │   --skip-tags molecule-notest,notest
  │   /home/control/iac/ansible/molecule/default/converge.yml
  │
  │
  │ PLAY [Configure nginx worker settings] *****************************************
  │
  │ TASK [nginx.confをtemplateで配置する] ******************************************
  │ ok: [ubuntu-node3]
  │ ok: [ubuntu-node2]
  │ changed: [ubuntu-node1]
  │
  │ RUNNING HANDLER [reload nginx] *************************************************
  │ changed: [ubuntu-node1]
  │
  │ PLAY RECAP *********************************************************************
  │ ubuntu-node1               : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │ ubuntu-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │ ubuntu-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │
  └─ Return code: 0 ─────────────────────────────────────────────────────────────────
INFO     default ➜ converge: Executed: Successful
WARNING  Molecule executed 1 scenario (1 missing files)

DETAILS
default ➜ dependency: Executed: 2 missing (Remove from converge_sequence to suppress)
default ➜ create: Executed: Missing playbook (Remove from converge_sequence to suppress)
default ➜ prepare: Executed: Missing playbook (Remove from converge_sequence to suppress)
default ➜ converge: Executed: Successful

SCENARIO RECAP
default                   : actions=4  successful=1  disabled=0  skipped=0  missing=4  failed=0
```

`create`・`prepare`が`Missing playbook`と表示されていますが、これはセクション3・4で整理した通り、この回では対応するPlaybookを用意していないためです。エラーではなく、該当フェーズに実行するPlaybookが定義されていないことを示す通知です。

今回の実行では、Node1のみ`changed`となり、Node2・Node3は`ok`のまま変更が発生しませんでした。これは各ノードの事前状態が完全には一致していなかったためであり、Moleculeやconvergeフェーズの動作による違いではありません。Ansibleの`changed`は、対象ノードの現在の状態と期待する状態(desired state)との差分によって決まります。Node1はdesired stateとの差分があったため`changed`、Node2・Node3はすでにdesired stateに一致していたため`ok`という結果です。

続けてidempotenceフェーズを実行します。

* **`idempotence`の実行**

```
(ansible-env) control@ubuntu-controller:~/iac/ansible$ molecule idempotence
INFO     default ➜ discovery: scenario test matrix: idempotence
INFO     default ➜ prerun: Performing prerun with role_name_check=0...
INFO     default ➜ idempotence: Executing
  ┌──────────────────────────────────────────────────────────────────────────────────
  │ ansible-playbook --inventory /home/control/.ansible/tmp/molecule.DLh_.default/inventory
  │   --skip-tags molecule-notest,notest,molecule-idempotence-notest
  │   /home/control/iac/ansible/molecule/default/converge.yml
  │
  │
  │ PLAY [Configure nginx worker settings] *****************************************
  │
  │ TASK [nginx.confをtemplateで配置する] ******************************************
  │ ok: [ubuntu-node3]
  │ ok: [ubuntu-node2]
  │ ok: [ubuntu-node1]
  │
  │ PLAY RECAP *********************************************************************
  │ ubuntu-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │ ubuntu-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │ ubuntu-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │
  └─ Return code: 0 ─────────────────────────────────────────────────────────────────
INFO     default ➜ idempotence: Executed: Successful
INFO     Molecule executed 1 scenario (1 successful)

DETAILS
default ➜ idempotence: Executed: Successful

SCENARIO RECAP
default                   : actions=1  successful=1  disabled=0  skipped=0  missing=0  failed=0
```

1回目の実行でNode1に発生した差分は、この時点ですでに解消されています。2回目の実行ではすべてのノードが`ok`となり、`changed=0`で完了しています。`idempotence: Executed: Successful`という行が、Moleculeがこの結果を「冪等性を満たしている」と判定したことを示しています。

この結果から、「同じプレイブックを再実行しても不要な変更は発生しない」とMoleculeが判断したことが分かります。これが冪等性(idempotence)の確認です。

見るべき行は`PLAY RECAP`の`changed`の数と、末尾の`idempotence: Executed: Successful`の2箇所です。`changed=0`がすべてのノードで揃っていること、そしてMolecule側がそれを成功と判定していることの両方を確認します。

---

[↑ 目次に戻る](#目次)

---

## 6. 冪等性違反を意図的に再現する：異常系の出力

対象のプレイブックに、`command`モジュールで`date`コマンドを実行するタスクを一時的に追加します。`command`モジュールで実行した`date`コマンドは状態の変化をAnsibleが判定できないため、実行のたびに`changed`として扱われ、何度実行しても冪等になりません。

**＜追加内容＞**
```yaml
    - name: Always changed task (for Molecule test)
      ansible.builtin.command: date
```

**＜追加後＞**

**ファイル名：`configure_nginx.yml`**

```yaml
---
- name: Configure nginx worker settings
  hosts: nodes
  become: true
  gather_facts: false
  vars:
    nginx_worker_connections: 768

  tasks:
    - name: nginx.confをtemplateで配置する
      ansible.builtin.template:
        src: ../templates/nginx.conf.j2
        dest: /etc/nginx/nginx.conf
        owner: root
        group: root
        mode: '0644'
      notify: reload nginx

    - name: Always changed task (for Molecule test)
      ansible.builtin.command: date

  handlers:
    - name: reload nginx
      ansible.builtin.systemd:
        name: nginx
        state: reloaded
```




この状態でconvergeを実行します。

* **`Converge`実行**
```plaintext
(ansible-env) control@ubuntu-controller:~/iac/ansible$ molecule converge
INFO     default ➜ discovery: scenario test matrix: dependency, create, prepare, converge
INFO     default ➜ prerun: Performing prerun with role_name_check=0...
INFO     default ➜ dependency: Executing
WARNING  default ➜ dependency: Missing roles requirements file: requirements.yml
WARNING  default ➜ dependency: Missing collections requirements file: collections.yml
WARNING  default ➜ dependency: Executed: 2 missing (Remove from converge_sequence to suppress)
INFO     default ➜ create: Executing
WARNING  default ➜ create: Skipping, instances already created.
INFO     default ➜ create: Executed: Skipped (Skipping, instances already created.)
INFO     default ➜ prepare: Executing
WARNING  default ➜ prepare: Executed: Missing playbook (Remove from converge_sequence to suppress)
INFO     default ➜ converge: Executing
  ┌──────────────────────────────────────────────────────────────────────────────────
  │ ansible-playbook --inventory /home/control/.ansible/tmp/molecule.DLh_.default/inventory
  │   --skip-tags molecule-notest,notest
  │   /home/control/iac/ansible/molecule/default/converge.yml
  │
  │
  │ PLAY [Configure nginx worker settings] *****************************************
  │
  │ TASK [nginx.confをtemplateで配置する] ******************************************
  │ ok: [ubuntu-node2]
  │ ok: [ubuntu-node3]
  │ ok: [ubuntu-node1]
  │
  │ TASK [Always changed task (for Molecule test)] *********************************
  │ changed: [ubuntu-node1]
  │ changed: [ubuntu-node3]
  │ changed: [ubuntu-node2]
  │
  │ PLAY RECAP *********************************************************************
  │ ubuntu-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │ ubuntu-node2               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │ ubuntu-node3               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │
  └─ Return code: 0 ─────────────────────────────────────────────────────────────────
INFO     default ➜ converge: Executed: Successful
WARNING  Molecule executed 1 scenario (1 missing files)

DETAILS
default ➜ dependency: Executed: 2 missing (Remove from converge_sequence to suppress)
default ➜ create: Executed: Skipped (Skipping, instances already created.)
default ➜ prepare: Executed: Missing playbook (Remove from converge_sequence to suppress)
default ➜ converge: Executed: Successful

SCENARIO RECAP
default                   : actions=4  successful=1  disabled=0  skipped=1  missing=3  failed=0
```


`create`の表示が、正常系(セクション5)の`Missing playbook`から`Skipping, instances already created.`に変わっています。これはMoleculeが対象ノードをすでに存在するインスタンスとして認識しているためであり、この時点で新たに何かを作成したわけではありません。`prepare`は引き続き対応するPlaybookが定義されていないことを示す通知です。

templateタスクはすでに前回のconvergeで適用済みのため`ok`のままですが、追加した`Always changed task`は全ノードで`changed`になっています。ここまではプレイブックの実行結果であり、正常に完走しています。

続けてidempotenceフェーズを実行します。

* **idempotenceを実行**

```plaintext
(ansible-env) control@ubuntu-controller:~/iac/ansible$ molecule idempotence
INFO     default ➜ discovery: scenario test matrix: idempotence
INFO     default ➜ prerun: Performing prerun with role_name_check=0...
INFO     default ➜ idempotence: Executing
  ┌──────────────────────────────────────────────────────────────────────────────────
  │ ansible-playbook --inventory /home/control/.ansible/tmp/molecule.DLh_.default/inventory
  │   --skip-tags molecule-notest,notest,molecule-idempotence-notest
  │   /home/control/iac/ansible/molecule/default/converge.yml
  │
  │
  │ PLAY [Configure nginx worker settings] *****************************************
  │
  │ TASK [nginx.confをtemplateで配置する] ******************************************
  │ ok: [ubuntu-node1]
  │ ok: [ubuntu-node2]
  │ ok: [ubuntu-node3]
  │
  │ TASK [Always changed task (for Molecule test)] *********************************
  │ changed: [ubuntu-node3]
  │ changed: [ubuntu-node2]
  │ changed: [ubuntu-node1]
  │
  │ PLAY RECAP *********************************************************************
  │ ubuntu-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │ ubuntu-node2               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │ ubuntu-node3               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │
  └─ Return code: 0 ─────────────────────────────────────────────────────────────────
CRITICAL Idempotence test failed because of the following tasks:
*  => Always changed task (for Molecule test)
*  => Always changed task (for Molecule test)
*  => Always changed task (for Molecule test)
ERROR    default ➜ idempotence: Executed: Failed
ERROR    Idempotence test failed because of the following tasks:
*  => Always changed task (for Molecule test)
*  => Always changed task (for Molecule test)
*  => Always changed task (for Molecule test)
```

2回目の実行でも`Always changed task`が`changed`のままです。templateタスクは`ok`で冪等性を保っていますが、追加したタスクだけが2回連続で`changed`になっています。

この結果を受けて、Moleculeは`CRITICAL Idempotence test failed because of the following tasks:`という行を出力し、続けて原因となったタスク名を列挙しています。今回は`Always changed task (for Molecule test)`という名前がそのまま表示されており、どのタスクが冪等性を満たしていないかが、この行から直接特定できます。

ここで注意したいのは、この失敗が「Ansibleの実行エラー」ではないという点です。`ansible-playbook`自体は`failed=0`のまま正常に完走しています。失敗しているのはMoleculeの判定であり、「2回目の実行でも変更が発生した、つまり冪等性が満たされていない」とMoleculeが判断した結果です。Ansibleはプレイブックを指示通り実行するツールであり、Moleculeはその実行結果が冪等かどうかを検証するツールです。この回の実行結果は、両者の役割の違いをそのまま表しています。

正常系(セクション5)と比べると、`PLAY RECAP`の`changed`の数、そして末尾に`CRITICAL`という行が追加されている点が違いです。つまり、`PLAY RECAP`だけを見るのではなく、`CRITICAL Idempotence test failed because of the following tasks:`まで確認することで、「どのタスクが冪等性を満たしていないか」をログから特定できます。これがMoleculeによる冪等性テストの読み方です。

---

[↑ 目次に戻る](#目次)

---

## 7. まとめ

- 対象のプレイブックは冪等性シリーズで使用したものをそのまま利用し、新たにテスト用のプレイブックは用意しなかった
- 今回確認したのは「プレイブックが何度実行しても不要な変更を発生させないこと」であり、この目的にはconverge・idempotenceの2フェーズで足りる。create・destroyが担う役割(初回適用の厳密な保証、テスト間の独立性)自体は重要だが、今回のテーマの範囲では必要にならなかった
- convergeフェーズの出力から、`changed`の有無はノードの現在の状態とdesired stateとの差分で決まることを確認した
- idempotenceフェーズの出力から、`changed=0`が確認できることの意味と、`idempotence: Executed: Successful`という判定行の位置を確認した。同じプレイブックを再実行しても不要な変更が発生しないことをMoleculeが判断した結果であり、これが冪等性(idempotence)の確認そのものであることを整理した
- 冪等でないタスクを意図的に加えた結果、idempotenceフェーズが失敗し、`CRITICAL Idempotence test failed because of the following tasks:`という行からどのタスクが原因かを特定できることを確認した
- この失敗はAnsibleの実行エラーではなく、Moleculeが冪等性の違反を検知した結果であることを整理した

---

[↑ 目次に戻る](#目次)

---

## 8. 次回予告

今回は、実行して初めて確認できる「動的なテスト」の内容を扱いました。

次回は、プレイブックを実行する前に設計上の問題を検出する静的チェックを扱います。

**[次回：第3回：ansible-lintはなぜそのルールを定めているのか](http://localhost:4321/blog/infra/ansible/ansible-molecule/ansible-molecule-03/)**

---

📑 連載の移動　**[前の記事：【Molecule編】 第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-01/)　｜　[次の記事：【Molecule編】 第3回](http://localhost:4321/blog/infra/ansible/ansible-molecule/ansible-molecule-03/)**


---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleのPlaybookが壊れる理由はテスト文化にあった」 シリーズまとめブログ** **※近日公開予定**

---

[↑ 目次に戻る](#目次)

---

## 9. 連載一覧：「AnsibleのPlaybookが壊れる理由はテスト文化にあった」

|回|タイトル|内容（概要）|
|---|---|---|
|**[第0回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-00/)**|なぜPlaybookにテストが必要なのか|「実行して成功した」と「正しい」は別の概念であることを整理し、手動確認の構造的な限界を理解する。テストを持つことの本質が「確認を仕組みに組み込むこと」であることを理解する。|
|**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-01/)**|Moleculeは何をしているのか|create・converge・idempotency・verify・destroyという各フェーズが何のためにあるかを、冪等性の文脈と接続しながら理解する。「2回実行してchanged=0」という手動確認をMoleculeが自動化している構造であることを整理する。|
|**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-02/)**|冪等性テストを自動化する|冪等性シリーズで作成したPlaybookをMoleculeでテストする構成を実機で確認し、1回目と2回目の実行で何が確認されているかを読み取る。idempotencyフェーズで`changed`が発生した場合の表示を意図的に再現し、テストが失敗するとはどういう状態かを理解する。|
|**[第3回](http://localhost:4321/blog/infra/ansible/ansible-molecule/ansible-molecule-03/)**|ansible-lintはなぜそのルールを定めているのか|ansible-lintのルールを設計品質の静的確認として位置づけ、代表的なルールカテゴリが冪等性・ドリフトの問題とどう接続しているかを理解する。MoleculeのverifyフェーズにAnsible-lintを組み込み、テストパイプラインの一部として位置づける。|
|**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-04/)**|テストが失敗したとき何が分かるのか・CIに組み込む|Moleculeのテスト失敗パターンを、設計上の何が問題なのかというフィードバックとして読む視点を理解する。GitHub ActionsなどのCIにMoleculeとansible-lintを組み込み、「変更のたびに確認し続ける」仕組みを整理する。|


---

[↑ 目次に戻る](#目次)

---