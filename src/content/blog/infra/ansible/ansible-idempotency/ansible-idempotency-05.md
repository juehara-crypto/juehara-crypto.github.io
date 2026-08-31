---
title: '「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第5回：なぜchangedはサービスを再起動させるのか'
description: 'service/systemd/handler の notify 連鎖を通して、「変更検知」がどのように状態遷移を引き起こすのかを理解する。reload/restart の違いも整理する。'
pubDate: '2026-07-28'
category: 'infra'
tags: ['Ansible', '冪等性', 'idempotency', 'notify', 'handler', 'changed', 'desired state']
seriesId: 'ansible-idempotency'
seriesNo: 5
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/'
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
2. [changedは単なる表示ではない](#2-changedは単なる表示ではない)
3. [notify と handler の仕組み](#3-notify-と-handler-の仕組み)
4. [handler は遅延実行される](#4-handlerは遅延実行される)
5. [reloadとrestartは何が違うのか](#5-reloadとrestartは何が違うのか)
6. [誤差分が restart を引き起こす](#6-誤差分がrestartを引き起こす)
7. [冪等性が崩れると副作用が連鎖する](#7-冪等性が崩れると副作用が連鎖する)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜](#10-連載一覧ansibleは本当に冪等なのか冪等性が崩れる構造と設計)

---

## 1. はじめに

**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/)** では、`state: latest` やバージョン未固定の指定によって、`desired state` 自体が実行時点の外部状態に依存する問題を取り上げました。同じPlaybookを実行しても、リポジトリの状態が変わっていれば結果が変わります。

今回はさらに別の問題に進みます。desired stateが固定されていても、`changed=1` が発生したとき、それが次の状態遷移を引き起こす構造です。

Ansibleには `notify` と `handler` という仕組みがあります。タスクが `changed=1` を返したとき、その変更検知をトリガーとしてサービスの再起動やリロードが実行されます。この回では、`changed` がどのように状態遷移を連鎖させるのかを整理します。


---

[↑ 目次に戻る](#-目次)

---

## 2. changedは単なる表示ではない

Ansibleの実行結果で `changed=1` を見ると、「変更された」という報告として読みがちです。しかし `changed` はログ上の表示にとどまりません。

`changed=1` はAnsible内部で「状態変化イベント」として扱われます。このイベントは `notify` を通じて `handler` を発火させ、サービスの再起動やリロードといった後続の状態遷移を引き起こします。

**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** で確認した `changed_when: false` は、この `changed` の報告を抑制するオプションでした。しかし `changed_when` が制御するのは表示だけではなく、`handler` の発火も合わせて抑制します。つまり `changed` は「表示」と「状態遷移トリガー」の2つの役割を持っています。


---

[↑ 目次に戻る](#-目次)

---

## 3. notify と handler の仕組み

`notify` はタスクに付与するキーワードで、そのタスクが `changed=1` になったときに指定した `handler` を呼び出します。

```yaml
tasks:
  - name: nginx の設定ファイルを配置する
    ansible.builtin.template:
      src: templates/nginx.conf.j2
      dest: /etc/nginx/nginx.conf
    notify:
      - nginx を再起動する

handlers:
  - name: nginx を再起動する
    ansible.builtin.service:
      name: nginx
      state: restarted
```

このPlaybookでは、`template` タスクが `changed=1` を返したときだけ `nginx を再起動する` handlerが実行されます。`changed=0` であればhandlerは呼び出されません。

この仕組みは「設定ファイルに変更があったときだけサービスを再起動する」という意図に合っています。問題が生じるのは、意図しない `changed=1` が発生したときです。


---

[↑ 目次に戻る](#-目次)

---

## 4. handlerは遅延実行される

`notify` で登録された `handler` は、タスクが `changed=1` になった時点で即座に実行されるわけではありません。Ansibleは `handler` をキューに積み、play内のすべてのタスクが完了した後にまとめて実行します。

また、複数のタスクが同じ `handler` を `notify` した場合、その `handler` は1回だけ実行されます。

この動作を実際に確認します。2つのタスクが同じ `handler` を `notify` する構成で、handlerがいつ・何回実行されるかを見ます。

---

### ■ 検証内容（handlerの遅延実行と重複排除）

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

**【コントローラーノード側】**

事前にファイルを作成しておきます。

```plaintext
echo "server_name localhost;" > files/nginx.conf
echo "worker_processes 1;" > files/nginx_worker.conf
```

**ファイル名: `test_handler_delay.yml`**

```yaml
---
- name: handlerの遅延実行確認
  hosts: test_servers
  gather_facts: false
  become: true

  tasks:
    - name: '設定ファイル1を配置する（nginx.conf）'
      ansible.builtin.copy:
        src: files/nginx.conf
        dest: /tmp/nginx.conf
        owner: root
        group: root
        mode: '0644'
      notify:
        - nginx を再起動する

    - name: '設定ファイル2を配置する（nginx_worker.conf）'
      ansible.builtin.copy:
        src: files/nginx_worker.conf
        dest: /tmp/nginx_worker.conf
        owner: root
        group: root
        mode: '0644'
      notify:
        - nginx を再起動する

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
ansible-playbook -i inventory.ini test_handler_delay.yml
```

**▼ 1回目の実行結果**

```plaintext
PLAY [handlerの遅延実行確認] ****************************************************************************************************************************************************************

TASK [設定ファイル1を配置する（nginx.conf）] ************************************************************************************************************************************************
changed: [192.168.1.21]
changed: [192.168.1.22]

TASK [設定ファイル2を配置する（nginx_worker.conf）] *****************************************************************************************************************************************
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

handlerの実行タイミングをjournalctlで確認します。

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ sudo journalctl -u nginx -n 10
 6月 20 16:55:02 localhost.localdomain nginx[1342]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 20 16:55:02 localhost.localdomain nginx[1342]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 20 16:55:02 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 20 16:59:47 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 20 16:59:47 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 20 16:59:47 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 20 16:59:47 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 20 16:59:47 localhost.localdomain nginx[2203]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 20 16:59:47 localhost.localdomain nginx[2203]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 20 16:59:47 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo journalctl -u nginx -n 10
 6月 20 16:57:51 localhost.localdomain nginx[1909]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 20 16:57:51 localhost.localdomain nginx[1909]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 20 16:57:51 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 20 16:59:48 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 20 16:59:48 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 20 16:59:48 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 20 16:59:48 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 20 16:59:48 localhost.localdomain nginx[2753]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 20 16:59:48 localhost.localdomain nginx[2753]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 20 16:59:48 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```

---

#### ■ 2回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_handler_delay.yml
```

**▼ 2回目の実行結果**

```plaintext
PLAY [handlerの遅延実行確認] ****************************************************************************************************************************************************************

TASK [設定ファイル1を配置する（nginx.conf）] ************************************************************************************************************************************************
ok: [192.168.1.21]
ok: [192.168.1.22]

TASK [設定ファイル2を配置する（nginx_worker.conf）] *****************************************************************************************************************************************
ok: [192.168.1.21]
ok: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ sudo journalctl -u nginx -n 10
 6月 20 16:55:02 localhost.localdomain nginx[1342]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 20 16:55:02 localhost.localdomain nginx[1342]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 20 16:55:02 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 20 16:59:47 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 20 16:59:47 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 20 16:59:47 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 20 16:59:47 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 20 16:59:47 localhost.localdomain nginx[2203]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 20 16:59:47 localhost.localdomain nginx[2203]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 20 16:59:47 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo journalctl -u nginx -n 10
 6月 20 16:57:51 localhost.localdomain nginx[1909]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 20 16:57:51 localhost.localdomain nginx[1909]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 20 16:57:51 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 20 16:59:48 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 20 16:59:48 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 20 16:59:48 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 20 16:59:48 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 20 16:59:48 localhost.localdomain nginx[2753]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 20 16:59:48 localhost.localdomain nginx[2753]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 20 16:59:48 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```

---

### ■ 結果

1回目の実行では、2つのcopyタスクがそれぞれ `changed=1` を返しました。どちらのタスクも同じ `nginx を再起動する` handlerを `notify` しています。Ansibleの出力を見ると、2つのタスクが完了した後に `RUNNING HANDLER [nginx を再起動する]` が1回だけ実行されています。PLAY RECAPの `changed=3` は、2つのcopyタスクと1回のhandler実行の合計です。

journalctlを確認すると、両ノードともPlaybook実行（16:59）のタイミングで1回だけStop→Startが記録されています。2つのタスクがそれぞれ `notify` を発火させましたが、nginxの再起動は1回に集約されています。

2回目の実行では、両ノードともすべてのタスクが `ok` となり `changed=0` を返しました。タスクに差分がないため `notify` は発火せず、handlerは実行されませんでした。journalctlの内容が1回目と変わっていないことから、2回目の実行でnginxが再起動されていないことが確認できます。

この検証から2点が確認できました。1点目は、handlerはタスク完了後にまとめて実行されるという遅延実行の動作です。2点目は、複数のタスクが同じhandlerを `notify` しても、そのhandlerは1回だけ実行されるという重複排除の動作です。また2回目の実行で `changed=0` になったことで、handlerが発火しない場合にはnginxへの影響がまったく生じないことも合わせて確認できました。

---

[↑ 目次に戻る](#-目次)

---

## 5. reloadとrestartは何が違うのか

`handler` で呼び出されるサービス操作には `reload` と `restart` があります。この2つは状態遷移の重さが異なります。

`reload` は設定ファイルを再読み込みします。プロセス自体は維持されるため、既存の接続は継続します。nginxの場合、masterプロセスがworkerプロセスに新しい設定を読み込ませ、処理中のリクエストが完了するまで旧workerを維持します。

`restart` はプロセスを一度停止して再生成します。既存の接続は切断されます。セクション4の検証でjournalctlに記録されたStop→Startがこれに相当します。

handlerでの指定は以下のようになります。

```yaml
handlers:
  - name: nginx をリロードする
    ansible.builtin.service:
      name: nginx
      state: reloaded

  - name: nginx を再起動する
    ansible.builtin.service:
      name: nginx
      state: restarted
```

`changed=1` がどちらのhandlerを発火させるかによって、サービスへの影響範囲が変わります。設定変更への対応として `restart` を使っているPlaybookで意図しない `changed=1` が毎回発生すると、Playbookを実行するたびに接続が切断されます。`reload` で対応できる変更に対して `restart` を使っている場合、影響は必要以上に大きくなります。


---

[↑ 目次に戻る](#-目次)

---

## 6. 誤差分がrestartを引き起こす

**[第3回](http://localhost:4321/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03)** では、`template` モジュールを正しく使っていても意図しない `changed=1` が発生するパターンを取り上げました。Jinja2のwhitespace差分や改行コードの違いが、checksumの差分として検出されるケースです。

この誤差分に `notify` が組み合わさると、意味的には変更がないにもかかわらずサービスが再起動されます。

```
whitespace差分 → changed=1 → notify発火 → handler実行 → service restart
```

**[第3回](http://localhost:4321/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03)** で見た「checksumの差分として検出される」という現象が、ここでは「Playbookを実行するたびにサービスが再起動される」という影響として現れます。設定ファイルの内容は変わっていません。しかしAnsibleの観測上は毎回差分が検出されるため、毎回handlerが発火します。

なお、**[第1回](http://localhost:4321/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01)** で確認したshellモジュールは `desired state` を持たない代わりに `notify` による連鎖も発火しません。`file` / `copy` / `template` のような宣言型モジュールは差分検出と `notify` 連鎖の両方を持っています。そのため誤差分が発生したときの影響範囲は、shellモジュールを直接使う場合より大きくなることがあります。

---

[↑ 目次に戻る](#-目次)

---

## 7. 冪等性が崩れると副作用が連鎖する

ここまでの内容を整理します。

冪等性が正しく機能している場合、`changed=0` であれば `handler` は発火しません。セクション4の検証で確認したとおり、2回目の実行では両タスクが `ok` となり、nginxは再起動されませんでした。

冪等性が崩れて意図しない `changed=1` が発生すると、以下の連鎖が起きます。

```
冪等性の崩壊
↓
changed=1（誤検知）
↓
notify発火
↓
handler実行（restart/reload）
↓
サービスへの影響（接続切断など）
```

第1回から第4回で見てきた冪等性の崩壊パターンは、`notify` と `handler` が組み合わさることで、単なる表示上の問題ではなくサービスへの実際の影響として現れます。shellモジュールが毎回 `changed=1` を返す問題、Jinja2のwhitespace差分による誤検知、`state: latest` によるdesired stateの不安定さ、これらはいずれも `notify` が設定されているPlaybookでは再起動の連鎖につながります。

`changed` は「状態変化イベント」として設計されており、その連鎖を止めるには冪等性を正しく維持することが前提になります。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

- **`changed=1` は表示にとどまらず、`handler` の発火トリガーになる**。Ansibleにおける `changed` は「状態変化イベント」であり、後続の状態遷移を引き起こす。
- **`notify` はタスクが `changed=1` のときだけ `handler` を呼び出す**。`changed=0` であれば `handler` は発火しない。
- **`handler` はplay終了後にまとめて遅延実行される**。複数のタスクが同じ `handler` を `notify` しても、そのhandlerは1回だけ実行される。
- **`reload` と `restart` は状態遷移の重さが異なる**。`reload` はプロセスを維持したまま設定を再読み込みするが、`restart` はプロセスを停止・再生成するため既存の接続が切断される。
- **誤差分による `changed=1` は意図しないサービス再起動を引き起こす**。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)** で見たwhitespace差分や改行コードの問題は、`notify` が設定されているPlaybookでは再起動の連鎖につながる。
- **冪等性が崩れると副作用が連鎖する**。意図しない `changed=1` は `handler` を発火させ、サービスへの実際の影響として現れる。

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

今回は、`changed` が `notify` と `handler` を通じて状態遷移を連鎖させる構造を見ました。意図しない `changed=1` は表示上の問題にとどまらず、サービスの再起動という実際の影響として現れます。

次回はさらに別の問題に進みます。モジュールの設計そのものが「状態全体を管理していない」というケースです。

**[次回：第6回：なぜlineinfileは"安全そうに見えて危険"なのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/)**

`lineinfile` モジュールはファイルに1行追加・変更する操作を行います。一見すると状態管理をしているように見えますが、その実体は「ファイル全体の状態」ではなく「特定の行への部分的な編集」です。正規表現の一致条件や挿入位置の指定によって、実行のたびに結果が変わる構造を持っています。

第5回が「変更検知が状態遷移を引き起こす」であれば、第6回は「そもそも状態全体を見ていない」という問題です。

---

📑 連載の移動　**[前の記事：【冪等性編】 第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/)　｜　[次の記事：【冪等性編】 第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 シリーズまとめブログ** **※近日公開予定**

---


[↑ 目次に戻る](#-目次)

---

## 10. 連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 


| 回    | タイトル                            | 内容（概要）                                                                                               |
| ---- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **[第0回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-00/)**  | なぜAnsibleは「何度実行しても安全」だと思われているのか | 冪等性（idempotency）の本来の意味を整理し、「同じコマンドを繰り返せる」ことと「状態が収束する」ことの違いを理解する。                                     |
| **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)**  | shellモジュールはなぜ“状態”を扱えないのか        | shell/command が desired state を持てない理由を構造から整理する。changed_when は表示制御であり、冪等性保証ではないことを理解する。               |
| **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-02/)**  | なぜAnsible moduleは「変更不要」を判断できるのか | file/copy/template などの module が、現在状態と desired state の差分比較によって動作していることを理解する。Ansibleが宣言的管理に見える理由を整理する。 |
| **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)**  | なぜファイル操作は簡単に非冪等になるのか            | 改行コード、owner/group、Jinja2レンダリング差分など、「見えない差分」が changed を発生させる構造を理解する。                          |
| **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/)**  | なぜ“最新化”は冪等性を壊すのか                | yum/apt の state: latest やバージョン未固定が、再実行ごとに状態を変化させる理由を理解する。desired state と「現在の最新版」は別物であることを学ぶ。         |
| **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-05/)**  | なぜサービス制御は再起動ループを生むのか            | service/systemd/handler の notify 連鎖を通して、「変更検知」がどのように状態遷移を引き起こすのかを理解する。reload/restart の違いも整理する。       |
| **[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/)**  | なぜlineinfileは“安全そうに見えて危険”なのか    | lineinfile は「状態管理」ではなく「部分パッチ」である。正規表現・重複挿入・文脈依存編集によって冪等性が崩れる構造を理解する。                                 |
| **[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-07/)**  | なぜ同じPlaybookなのに環境ごとに結果が変わるのか    | OS・ディストリビューション・systemd・Python・locale 差分によって、module の内部動作が変化することを理解する。                                |
| **[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/)**  | なぜタスクの依存関係は冪等性を壊すのか             | handler、register、条件分岐、タスク順序によって「前回実行結果」に依存したPlaybookが生まれる。状態遷移が閉じなくなる理由を整理する。                        |
| **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-09/)**  | 冪等性はどうやって検証すべきなのか               | check mode の限界、diff mode、molecule、CI、自動テストを通して、「2回目 changed=0」をどう保証するのかを理解する。                        |
| **[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-10/)** | 「冪等に設計する」とは何を設計することなのか          | imperative（手続き）ではなく declarative（状態宣言）としてPlaybookを設計する考え方を整理し、「壊れない構成管理」の原則を完成させる。                    |

---

[↑ 目次に戻る](#-目次)

---