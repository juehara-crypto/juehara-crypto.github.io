---
title: '「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第8回：なぜタスクの依存関係は冪等性を壊すのか'
description: 'handler、register、条件分岐、タスク順序によって「前回実行結果」に依存したPlaybookが生まれる。状態遷移が閉じなくなる理由を整理する。'
pubDate: '2026-07-29'
category: 'infra'
tags: ['Ansible', '冪等性', 'idempotency', 'handler', 'register', 'when']
seriesId: 'ansible-idempotency'
seriesNo: 8
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-09/'
relatedSeries: ''
---


> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 シリーズまとめブログ** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [Playbookは「静的定義」ではない](#2-playbookは静的定義ではない)
3. [registerが前回結果を後続タスクに持ち込む](#3-registerが前回結果を後続タスクに持ち込む)
4. [when条件が実行履歴に依存する](#4-when条件が実行履歴に依存する)
5. [handler・register・whenが組み合わさると状態遷移が複雑化する](#5-handlerregisterwhenが組み合わさると状態遷移が複雑化する)
6. [タスク順序が状態依存を生む](#6-タスク順序が状態依存を生む)
7. [状態遷移が閉じなくなるとは何か](#7-状態遷移が閉じなくなるとは何か)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜](#10-連載一覧ansibleは本当に冪等なのか冪等性が崩れる構造と設計)

---

## 1. はじめに

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-07/)** では、Playbookの記述が「抽象命令」であり、モジュールが内部で呼び出すコマンドはリモートノードの実行環境が決めるという構造を確認しました。OS・サービスマネージャー・Pythonバージョンといった外部環境の差分が、モジュールの内部処理を揺らすという問題でした。

今回はさらに別の問題に進みます。実行環境が安定していても、Playbook内部のロジックそのものが状態遷移を揺らすケースです。


```yaml
- name: パッケージをインストールする
  ansible.builtin.dnf:
    name: nginx
    state: present
  register: install_result

- name: インストール結果を表示する
  ansible.builtin.debug:
    msg: "インストールが実行されました"
  when: install_result.changed
```

このPlaybookは記述として正しく、エラーも出ません。しかし1回目と2回目の実行で動作が変わります。`register` と `when` の組み合わせによって、後続タスクの実行有無が「現在のシステム状態」ではなく「直前タスクの実行結果」に依存しているからです。

`handler` が `changed=1` をトリガーとして状態遷移を引き起こす構造は第5回で実機確認しています。この回では `handler` の仕組みそのものは扱いません。`register` や `when` との組み合わせによって状態遷移がどう複雑化するかを中心に見ていきます。


---

[↑ 目次に戻る](#-目次)

---

## 2. Playbookは「静的定義」ではない

Ansibleは宣言型ツールとして説明されることが多いです。`state: present` や `state: started` のような記述は「あるべき状態」を宣言しており、モジュールがその状態との差分を検出して必要な操作だけを行います。この構造が冪等性の基盤になっていることは、第2回で確認しました。

しかし `register` / `when` / `notify` を使い始めると、Playbookの性質が変わり始めます。

```yaml
- name: 設定ファイルを配置する
  ansible.builtin.template:
    src: templates/nginx.conf.j2
    dest: /etc/nginx/nginx.conf
  register: config_result
  notify: nginx を再起動する

- name: 追加設定を配置する
  ansible.builtin.copy:
    src: files/nginx_extra.conf
    dest: /etc/nginx/conf.d/extra.conf
  when: config_result.changed
```

このPlaybookでは、2つ目のタスクの実行有無が1つ目のタスクの `changed` 値によって決まります。1つ目が `changed=1` なら2つ目は実行され、`changed=0` なら実行されません。さらに `notify` によってhandlerの発火も連動しています。

各タスクは独立した状態宣言ではなく、前のタスクの結果を受けて動作が変わる構造になっています。「現在のシステム状態」ではなく「直前の実行で何が起きたか」が後続タスクの動作を決めています。

本来の冪等性は「何回実行しても同じ状態へ収束する」ことです。しかし実行履歴に依存した構造になると、初回実行と2回目以降で動作経路が変わります。Playbookの記述は変わっていないにもかかわらず、実行のたびに「どのタスクがchangedだったか」という履歴が蓄積され、その履歴が次の実行に影響します。

これはPlaybookが「静的な状態定義」ではなく、実行のたびに異なる経路をたどる可能性がある「状態遷移グラフ」になっている状態です。`register` / `when` / `notify` の組み合わせが増えるほど、その経路の数は増えます。

具体的にどのような構造でこの問題が生じるかを、次のセクションから順に見ていきます。

---

[↑ 目次に戻る](#-目次)

---

## 3. registerが前回結果を後続タスクに持ち込む

`register` を使って前のタスクの実行結果を変数に保持し、後続タスクの `when` 条件で参照する構成を取り上げます。


```yaml
- name: パッケージをインストールする
  ansible.builtin.dnf:
    name: nginx
    state: present
  register: install_result

- name: インストール結果を表示する
  ansible.builtin.debug:
    msg: "インストールが実行されました"
  when: install_result.changed
```

2つ目のタスクの実行有無は `install_result.changed` の値によって決まります。これは「現在のシステム状態」ではなく「直前タスクが changed=1 を返したかどうか」です。初回実行では nginx がインストールされていないため `install_result.changed` が `true` になり、2つ目のタスクが実行されます。2回目以降は nginx がすでにインストール済みのため `install_result.changed` が `false` になり、2つ目のタスクはスキップされます。

Playbookの記述は変わっていません。しかし実行回数によって動作が変わります。これを実機で確認します。

---

### ■ 検証内容（registerによる前回結果の持ち込み）

【事前準備】リモートノード側のnginx未インストール確認

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ sudo rpm -q nginx
パッケージ nginx はインストールされていません。
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo sudo rpm -q nginx
パッケージ nginx はインストールされていません。
```


**ファイル名: `test_register_result.yml`**

```yaml
---
- name: registerによる前回結果の持ち込み確認
  hosts: test_servers
  gather_facts: false
  become: true

  tasks:
    - name: パッケージをインストールする
      ansible.builtin.dnf:
        name: nginx
        state: present
      register: install_result

    - name: インストール結果を表示する
      ansible.builtin.debug:
        msg: "インストールが実行されました"
      when: install_result.changed
```

---

#### ■ 1回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_register_result.yml
```

**▼ 1回目の実行結果**

```plaintext
PLAY [registerによる前回結果の持ち込み確認] *************************************************************************************************************************************************

TASK [パッケージをインストールする] *********************************************************************************************************************************************************
changed: [192.168.1.22]
changed: [192.168.1.21]

TASK [インストール結果を表示する] ***********************************************************************************************************************************************************
ok: [192.168.1.21] => {
    "msg": "インストールが実行されました"
}
ok: [192.168.1.22] => {
    "msg": "インストールが実行されました"
}

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```


**【1回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ sudo rpm -q nginx
nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo rpm -q nginx
nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
```


---

#### ■ 2回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_register_result.yml
```

**▼ 2回目の実行結果**

```plaintext
PLAY [registerによる前回結果の持ち込み確認] *************************************************************************************************************************************************

TASK [パッケージをインストールする] *********************************************************************************************************************************************************
ok: [192.168.1.22]
ok: [192.168.1.21]

TASK [インストール結果を表示する] ***********************************************************************************************************************************************************
skipping: [192.168.1.21]
skipping: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**


- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ sudo rpm -q nginx
nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo rpm -q nginx
nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
```



---

### ■ 結果

リモートノード側を確認すると、1回目の実行でnginxがインストールされ、2回目の実行後もその状態が維持されています。システムの状態自体は2回目の実行で変わっていません。

ここで確認できるのは、2つ目のタスクの実行有無を決めているのが「システムの現在状態」ではないという点です。nginxがインストール済みかどうかはリモートノード側の状態であり、その状態は2回目の実行前後で変わっていません。しかし2つ目のタスクは1回目には実行され、2回目にはスキップされました。判断の根拠は `install_result.changed` という「直前タスクが今回の実行でchangedを返したかどうか」です。同じPlaybookを実行しても、実行回数によって動作経路が変わっています。

---

[↑ 目次に戻る](#-目次)

---

## 4. when条件が実行履歴に依存する

`when` 条件が何を参照しているかによって、タスクの実行有無の判断基準が変わります。このセクションではセクション3で確認した構造をさらに掘り下げ、`when` 条件の参照先が「システムの現在状態」か「実行履歴」かという違いに焦点を当てます。

以下の2つの `when` 条件を比較します。

**システムの現在状態を参照する条件**


```yaml
- name: RedHat系の場合のみ実行する
  ansible.builtin.dnf:
    name: nginx
    state: present
  when: ansible_os_family == "RedHat"
```

**実行履歴を参照する条件**


```yaml
- name: インストールが実行された場合のみ実行する
  ansible.builtin.debug:
    msg: "インストールが実行されました"
  when: install_result.changed
```

前者の `when: ansible_os_family == "RedHat"` はリモートノードのOS種別を参照しています。この値はリモートノードの環境が変わらない限り変化しません。何回実行しても同じ条件で判断されます。

後者の `when: install_result.changed` は「直前タスクが今回の実行で `changed=1` を返したかどうか」を参照しています。この値はシステムの現在状態ではなく、今回の実行でそのタスクが差分を検出したかどうかです。初回実行か2回目以降かによって値が変わります。

この違いを整理すると以下のようになります。

| when条件の参照先               | 例                                       | 実行回数による変化        |
| ------------------------ | --------------------------------------- | ---------------- |
| システムの現在状態                | `ansible_os_family == "RedHat"`         | 環境が変わらない限り変化しない  |
| gather_factsの情報          | `ansible_distribution_version == "9.7"` | 環境が変わらない限り変化しない  |
| 実行履歴（register変数のchanged） | `install_result.changed`                | 実行のたびに変化する可能性がある |

`when` 条件自体はAnsibleの正当な機能です。問題は参照先が「現在状態」か「実行履歴」かという判断基準のずれにあります。`when: install_result.changed` を使う場合、そのタスクの実行有無はシステムがどういう状態にあるかではなく、今回の実行で何が起きたかによって決まります。

セクション3の検証でこの動作はすでに確認しています。1回目は `install_result.changed` が `true` のため後続タスクが実行され、2回目は `false` のためスキップされました。システムの状態は両回とも「nginxがインストール済み」であり変わっていません。実行有無を分けたのはシステム状態ではなく実行履歴です。


---

[↑ 目次に戻る](#-目次)

---

## 5. handler・register・whenが組み合わさると状態遷移が複雑化する

第5回では、`notify` によってタスクの `changed=1` がhandlerの発火トリガーになる構造を実機で確認しました。単独では予測可能なこの動作も、`register` と `when` が加わると状態遷移の経路が複数に分岐します。

以下のPlaybookを例にします。

```yaml
- name: 設定ファイルを配置する
  ansible.builtin.template:
    src: templates/nginx.conf.j2
    dest: /etc/nginx/nginx.conf
  register: config_result
  notify: nginx を再起動する

- name: 追加設定を配置する
  ansible.builtin.copy:
    src: files/nginx_extra.conf
    dest: /etc/nginx/conf.d/extra.conf
  when: config_result.changed
  notify: nginx を再起動する
```

このPlaybookでは `config_result.changed` の値によって2つ目のタスクの実行有無が変わり、それに応じてhandlerの発火パターンも変わります。実行回数と状態の組み合わせによって、Playbookがたどる経路は以下のように分岐します。

| 実行状況        | 1つ目のタスク   | 2つ目のタスク          | handlerの発火 |
| ----------- | --------- | ---------------- | ---------- |
| 初回（どちらも未配置） | changed=1 | 実行・changed=1     | 発火する       |
| 2回目（両方配置済み） | changed=0 | スキップ             | 発火しない      |
| 1つ目のみ変更あり   | changed=1 | 実行・changed=0または1 | 発火する       |
| 1つ目に変更なし    | changed=0 | スキップ             | 発火しない      |

`notify` 単独であれば「changed=1なら発火、changed=0なら発火しない」という2経路です。そこに `register` と `when` が加わると、「どのタスクがchangedになったか」という組み合わせによって経路が増えます。

これを実機で確認します。nginxの設定ファイルを配置するPlaybookを2回実行し、1回目と2回目でhandlerの発火パターンが変わることを見ます。

---

### ■ 検証内容（handler・register・whenの複合動作確認）

**【事前準備】コントローラーノード側のファイル作成**


```plaintext
mkdir -p templates files
cat > templates/nginx.conf.j2 << 'EOF'
server_name {{ server_name }};
EOF
echo "worker_processes 1;" > files/nginx_extra.conf
```

**【事前確認】リモートノード側のnginx起動確認**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ sudo systemctl start nginx
[ansibleuser@localhost ~]$ systemctl is-active nginx
active
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo systemctl start nginx
[ansibleuser2@localhost ~]$ systemctl is-active nginx
active
```

**ファイル名: `test_handler_register_when.yml`**

```yaml
---
- name: 'handler・register・whenの複合動作確認'
  hosts: test_servers
  gather_facts: false
  become: true

  vars:
    server_name: localhost

  tasks:
    - name: 設定ファイルを配置する
      ansible.builtin.template:
        src: templates/nginx.conf.j2
        dest: /tmp/nginx_handler_test.conf
        owner: root
        group: root
        mode: '0644'
      register: config_result
      notify: nginx を再起動する

    - name: 追加設定を配置する
      ansible.builtin.copy:
        src: files/nginx_extra.conf
        dest: /tmp/nginx_extra_handler_test.conf
        owner: root
        group: root
        mode: '0644'
      when: config_result.changed
      notify: nginx を再起動する

  handlers:
    - name: nginx を再起動する
      ansible.builtin.service:
        name: nginx
        state: restarted
```

---

#### ■ 1回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_handler_register_when.yml
```

**▼ 1回目の実行結果**

```plaintext
PLAY [handler・register・whenの複合動作確認] ************************************************************************************************************************************************

TASK [設定ファイルを配置する] ***************************************************************************************************************************************************************
changed: [192.168.1.21]
changed: [192.168.1.22]

TASK [追加設定を配置する] *******************************************************************************************************************************************************************
changed: [192.168.1.21]
changed: [192.168.1.22]

RUNNING HANDLER [nginx を再起動する] ********************************************************************************************************************************************************
changed: [192.168.1.21]
changed: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=3    changed=3    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=3    changed=3    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【1回目のリモートノード側の確認】**

journalctlでnginxの再起動を確認します。


- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ sudo journalctl -u nginx -n 10
 6月 23 12:40:02 localhost.localdomain nginx[3166]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 23 12:40:02 localhost.localdomain nginx[3166]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 23 12:40:02 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 23 12:59:05 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 23 12:59:06 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 23 12:59:06 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 23 12:59:06 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 23 12:59:06 localhost.localdomain nginx[4888]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 23 12:59:06 localhost.localdomain nginx[4888]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 23 12:59:06 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo journalctl -u nginx -n 10
 6月 23 12:40:48 localhost.localdomain nginx[3389]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 23 12:40:48 localhost.localdomain nginx[3389]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 23 12:40:49 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 23 12:59:06 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 23 12:59:06 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 23 12:59:06 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 23 12:59:06 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 23 12:59:06 localhost.localdomain nginx[4909]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 23 12:59:06 localhost.localdomain nginx[4909]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 23 12:59:06 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```


---

#### ■ 2回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_handler_register_when.yml
```

**▼ 2回目の実行結果**

```plaintext
PLAY [handler・register・whenの複合動作確認] ************************************************************************************************************************************************

TASK [設定ファイルを配置する] ***************************************************************************************************************************************************************
ok: [192.168.1.21]
ok: [192.168.1.22]

TASK [追加設定を配置する] *******************************************************************************************************************************************************************
skipping: [192.168.1.21]
skipping: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**

journalctlでnginxの再起動を確認します。


- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ sudo journalctl -u nginx -n 10
 6月 23 12:40:02 localhost.localdomain nginx[3166]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 23 12:40:02 localhost.localdomain nginx[3166]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 23 12:40:02 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 23 12:59:05 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 23 12:59:06 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 23 12:59:06 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 23 12:59:06 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 23 12:59:06 localhost.localdomain nginx[4888]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 23 12:59:06 localhost.localdomain nginx[4888]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 23 12:59:06 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo journalctl -u nginx -n 10
 6月 23 12:40:48 localhost.localdomain nginx[3389]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 23 12:40:48 localhost.localdomain nginx[3389]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 23 12:40:49 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 23 12:59:06 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 23 12:59:06 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 23 12:59:06 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 23 12:59:06 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 23 12:59:06 localhost.localdomain nginx[4909]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 23 12:59:06 localhost.localdomain nginx[4909]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 23 12:59:06 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```



---

### ■ 結果

1回目の実行では、両ノードともすべてのタスクが `changed=1` となりました。「設定ファイルを配置する」タスクが `changed=1` を返したため `config_result.changed` が `true` になり、`when` 条件を持つ「追加設定を配置する」タスクも実行されています。両タスクがそれぞれ `notify` を発火させましたが、第5回で確認したとおり同じhandlerへの複数の `notify` は1回に集約され、`RUNNING HANDLER [nginx を再起動する]` が1回だけ実行されています。journalctlを確認すると、両ノードともPlaybook実行（12:59）のタイミングでStop→Startが記録されており、nginxが再起動されています。

2回目の実行では、「設定ファイルを配置する」タスクが両ノードとも `ok`（`changed=0`）となりました。ファイルはすでに配置済みのため差分なしと判断されています。`config_result.changed` が `false` になったため、`when` 条件を持つ「追加設定を配置する」タスクは `skipping` となり実行されませんでした。handlerも発火せず、journalctlの内容は1回目と変わっていません。2回目の実行でnginxが再起動されていないことが確認できます。

Playbookの記述は1回目と2回目で変わっていません。しかし1回目は「設定ファイル配置→追加設定配置→handler発火→nginx再起動」という経路をたどり、2回目は「設定ファイル差分なし→追加設定スキップ→handler未発火」という経路をたどっています。この経路の分岐を決めているのは `config_result.changed` の値、すなわち「1つ目のタスクが今回の実行でchangedを返したかどうか」という実行履歴です。`handler` / `register` / `when` が組み合わさることで、単独では予測可能だった各機能が複数の状態遷移経路を持つ構造になっています。


---

[↑ 目次に戻る](#-目次)

---

## 6. タスク順序が状態依存を生む

セクション3〜5で確認してきた `register` / `when` / `handler` の組み合わせには、もう一つ見落としやすい問題があります。タスクの順序そのものが状態遷移の意味を持つという点です。

以下の2つのPlaybookを比較します。

**パターンA：設定配置→サービス起動の順序**

```yaml
tasks:
  - name: 設定ファイルを配置する
    ansible.builtin.template:
      src: templates/nginx.conf.j2
      dest: /etc/nginx/nginx.conf
    register: config_result

  - name: nginxを起動する
    ansible.builtin.service:
      name: nginx
      state: started
    when: config_result.changed
```

**パターンB：サービス起動→設定配置の順序**


```yaml
tasks:
  - name: nginxを起動する
    ansible.builtin.service:
      name: nginx
      state: started

  - name: 設定ファイルを配置する
    ansible.builtin.template:
      src: templates/nginx.conf.j2
      dest: /etc/nginx/nginx.conf
    register: config_result
```

パターンAでは `config_result.changed` が `true` のときだけnginxが起動されます。設定ファイルの配置が先に行われ、その結果を受けてサービス起動が判断されます。パターンBではnginxの起動が先に実行され、設定ファイルの配置は起動の有無に関係なく後から行われます。タスクの記述内容は同じでも、順序が変わるだけでPlaybookの動作経路が変わります。

`register` を使った条件分岐がある場合、タスク順序は「どのタスクの結果を参照できるか」を決めます。後続タスクは前のタスクの `register` 変数しか参照できないため、タスクの並び順が状態遷移の構造そのものを規定します。これは `state: present` のような宣言型の記述とは性質が異なります。「このファイルが存在する状態にする」という宣言はどの順序で書いても意味が変わりませんが、「Aの結果を受けてBを実行する」という構造は順序に依存します。

Ansibleは宣言型ツールとして説明されますが、`register` と `when` を組み合わせた構造はその外観の中に手続き的なワークフローを持ち込んでいます。タスク順序が状態遷移の意味を持ち始めると、Playbookは「何回実行しても同じ状態へ収束する」という宣言型の性質から、「どの順序でどのタスクが実行されたか」に依存する手続き型の性質へ近づいていきます。

なお、タスク順序を入れ替えた実機検証については、今回の検証環境では `register` 変数の参照関係を壊さずに順序だけを入れ替えた構成を用意することが難しいため、概念説明にとどめます。

---

[↑ 目次に戻る](#-目次)

---

## 7. 状態遷移が閉じなくなるとは何か

セクション3〜6で確認した内容を整理します。

セクション3では `register` が前のタスクの実行結果を後続タスクに持ち込む構造を確認しました。セクション4では `when` 条件がシステムの現在状態ではなく実行履歴を参照している場合があることを整理しました。セクション5では `handler` / `register` / `when` が組み合わさることで状態遷移の経路が複数に分岐することを実機で確認しました。セクション6ではタスク順序そのものが状態遷移の構造を規定するという問題を整理しました。

これらに共通しているのは「Playbookの動作が実行履歴に依存し始める」という構造です。

冪等性の本来の定義は「何回実行しても同じ状態へ収束する」ことです。この定義が成立するためには、Playbookの動作経路が実行回数や実行履歴によらず一定である必要があります。しかし `register` / `when` / `handler` の組み合わせが増えると、「どのタスクが今回の実行でchangedを返したか」という履歴によって動作経路が変わります。経路が増えるほど、すべての経路で同じ最終状態へ収束することの保証は難しくなります。

第5回では `changed=1` が `notify` を通じてhandlerを発火させ、サービスの再起動という副作用を連鎖させる構造を確認しました。第7回では外部環境の差分がモジュールの内部処理を揺らす構造を確認しました。今回確認したのはその内側にある問題です。外部環境が安定していても、Playbook内部の `register` / `when` / `handler` の組み合わせそのものが実行履歴依存の構造を作り出します。

ここで重要なのは、これらの機能が問題なのではないという点です。`register` はタスクの実行結果を扱うための正当な機能です。`when` は条件分岐を記述するための正当な機能です。`handler` は変更検知に連動した操作を整理するための正当な機能です。問題は機能そのものではなく、これらの組み合わせが増えることで「実行履歴依存の経路」が増え、状態遷移が閉じなくなることにあります。

冪等性とは「同じタスクを書くこと」ではありません。`state: present` と書かれたタスクが並んでいても、それだけでは冪等性は保証されません。「状態遷移が閉じていること」、つまり実行回数や実行履歴によらず同じ最終状態へ収束する経路が設計されていることが、冪等性の実質的な意味です。Playbookが状態遷移グラフとして複雑化するほど、その設計は難しくなります。


---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

- **`register` は前のタスクの実行結果を後続タスクに持ち込む**。後続タスクの実行有無が「現在のシステム状態」ではなく「直前タスクが今回の実行でchangedを返したかどうか」によって決まる構造になる。

- **`when` 条件がシステムの現在状態ではなく実行履歴を参照する場合がある**。`when: ansible_os_family == "RedHat"` のような現在状態を参照する条件は実行回数によらず一定だが、`when: some_task.changed` のような実行履歴を参照する条件は実行タイミングによって判断が変わる。

- **`handler` / `register` / `when` が組み合わさると状態遷移の経路が複数に分岐する**。「どのタスクがchangedになったか」という実行履歴の組み合わせによってhandlerの発火パターンが変わり、Playbookの動作経路が変わる。

- **タスク順序が状態遷移の意味を持つ**。`register` を使った条件分岐がある場合、タスクの並び順が「どのタスクの結果を参照できるか」を決める。順序が変わるだけでPlaybookの動作経路が変わり、宣言型の性質から手続き型の性質へ近づいていく。

- **問題は機能そのものではなく、実行履歴依存の経路が増えることにある**。`register` / `when` / `handler` はいずれも正当な機能だが、組み合わせが増えるほど状態遷移の経路が増え、冪等性の保証が難しくなる。

- **冪等性とは「同じタスクを書くこと」ではなく「状態遷移を閉じること」である**。実行回数や実行履歴によらず同じ最終状態へ収束する経路が設計されていることが、冪等性の実質的な意味である。

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

今回は、`register` / `when` / `handler` の組み合わせによってPlaybookが実行履歴に依存した構造になり、状態遷移が閉じなくなる問題を確認しました。冪等性とは「同じタスクを書くこと」ではなく「状態遷移を閉じること」であり、その設計はPlaybookが複雑化するほど難しくなります。

次回はその先に進みます。状態遷移が正しく閉じているかどうかを、どうやって確認するかという問いです。

**[次回：第9回：冪等性はどうやって検証すべきなのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-09/)**

Ansibleには `--check` モード（ドライラン）や `--diff` モードといった検証を補助する機能があります。しかしこれらにも限界があります。また、MoleculeやCIを使った自動テストによって「2回目のPlaybook実行でchanged=0になること」をどう保証するかという問いもあります。第8回が「状態遷移は簡単に壊れる」であれば、第9回は「壊れていないことをどう確認するか」を扱います。

---

📑 連載の移動　**[前の記事：【冪等性編】 第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-07/)　｜　[次の記事：【冪等性編】 第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-09/)**


---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 シリーズまとめブログ**


---

[↑ 目次に戻る](#-目次)

---


## 10. 連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 


| 回                                                                                                          | タイトル                            | 内容（概要）                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **[第0回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-00/)** | なぜAnsibleは「何度実行しても安全」だと思われているのか | 冪等性（idempotency）の本来の意味を整理し、「同じコマンドを繰り返せる」ことと「状態が収束する」ことの違いを理解する。                                     |
| **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** | shellモジュールはなぜ“状態”を扱えないのか        | shell/command が desired state を持てない理由を構造から整理する。changed_when は表示制御であり、冪等性保証ではないことを理解する。               |
| **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-02/)** | なぜAnsible moduleは「変更不要」を判断できるのか | file/copy/template などの module が、現在状態と desired state の差分比較によって動作していることを理解する。Ansibleが宣言的管理に見える理由を整理する。 |
| **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)** | なぜファイル操作は簡単に非冪等になるのか            | 改行コード、owner/group、Jinja2レンダリング差分など、「見えない差分」が changed を発生させる構造を理解する。                                  |
| **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/)** | なぜ“最新化”は冪等性を壊すのか                | yum/apt の state: latest やバージョン未固定が、再実行ごとに状態を変化させる理由を理解する。desired state と「現在の最新版」は別物であることを学ぶ。         |
| **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-05/)** | なぜサービス制御は再起動ループを生むのか            | service/systemd/handler の notify 連鎖を通して、「変更検知」がどのように状態遷移を引き起こすのかを理解する。reload/restart の違いも整理する。       |
| **[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/)** | なぜlineinfileは“安全そうに見えて危険”なのか    | lineinfile は「状態管理」ではなく「部分パッチ」である。正規表現・重複挿入・文脈依存編集によって冪等性が崩れる構造を理解する。                                 |
| **[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-07/)** | なぜ同じPlaybookなのに環境ごとに結果が変わるのか    | OS・ディストリビューション・systemd・Python・locale 差分によって、module の内部動作が変化することを理解する。                                |
| **[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/)** | なぜタスクの依存関係は冪等性を壊すのか             | handler、register、条件分岐、タスク順序によって「前回実行結果」に依存したPlaybookが生まれる。状態遷移が閉じなくなる理由を整理する。                        |
| **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-09/)** | 冪等性はどうやって検証すべきなのか               | check mode の限界、diff mode、molecule、CI、自動テストを通して、「2回目 changed=0」をどう保証するのかを理解する。                        |
| **[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-10/)** | 「冪等に設計する」とは何を設計することなのか          | imperative（手続き）ではなく declarative（状態宣言）としてPlaybookを設計する考え方を整理し、「壊れない構成管理」の原則を完成させる。                    |


---

[↑ 目次に戻る](#-目次)

---
