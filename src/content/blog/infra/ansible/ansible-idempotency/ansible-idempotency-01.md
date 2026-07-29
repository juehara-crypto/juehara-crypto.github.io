---
title: '「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第1回：shellモジュールはなぜ"状態"を扱えないのか'
description: 'shell/commandモジュールがdesired stateを持てない理由を構造から整理する。changed_whenは表示制御であり、冪等性保証ではないことを理解する。'
pubDate: '2026-07-27'
category: 'infra'
tags: ['Ansible', '冪等性', 'idempotency', 'shell', 'command', 'desired state']
seriesId: 'ansible-idempotency'
seriesNo: 1
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-00/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-02/'
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
2. [なぜshellモジュールは毎回changedになるのか](#2-なぜshellモジュールは毎回changedになるのか)
3. [Ansibleモジュールは何を見ているのか](#3-ansibleモジュールは何を見ているのか)
4. [shellモジュールは「状態」を知らない](#4-shellモジュールは状態を知らない)
5. [desired stateを持てるモジュール、持てないモジュール](#5-desired-stateを持てるモジュール持てないモジュール)
6. [「成功した」と「状態が変わった」は別である](#6-成功したと状態が変わったは別である)
7. [なぜshellは構造的に冪等判定できないのか](#7-なぜshellは構造的に冪等判定できないのか)
8. [changed_whenは冪等性を保証しているのか](#8-changed_whenは冪等性を保証しているのか)
9. [changed_whenが「表示制御」に過ぎない理由](#9-changed_whenが表示制御に過ぎない理由)
10. [「差分検出」と「表示上の補正」は何が違うのか](#10-差分検出と表示上の補正は何が違うのか)
11. [shellモジュールを使っても良いケース](#11-shellモジュールを使っても良いケース)
12. [まとめ](#12-まとめ)
13. [連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 ](#13-連載一覧ansibleは本当に冪等なのか冪等性が崩れる構造と設計)


---

## 1. はじめに

**[第0回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-00/)** では、冪等性とは「状態遷移制御」であると整理しました。冪等なモジュールは現在の状態を観測し、目標の状態と比較し、差分がある場合のみ変更を加えます。この「変更しない能力」が冪等性の実体です。

今回はその続きとして、shellモジュールを取り上げます。

```yaml
- name: nginx を再起動する
  ansible.builtin.shell: systemctl restart nginx
```

このタスクは何度実行しても成功します。しかし、毎回 `changed=1` になります。`changed_when: false` を付ければ `changed=0` にはなりますが、それで冪等になったと言えるでしょうか。

この回では、shellモジュールが「なぜ構造的に冪等判定できないのか」を説明します。「shellは危険」という話ではなく、shellという仕組みが何を持っていて、何を持っていないのかの話です。

---

[↑ 目次に戻る](#-目次)

---


## 2. なぜshellモジュールは毎回changedになるのか

まず現象を確認します。

```yaml
- name: ディレクトリを作成する
  ansible.builtin.shell: mkdir -p /tmp/sample
```

`/tmp/sample` がすでに存在していても、このタスクを実行すると `changed=1` になります。`mkdir -p` はエラーを返さないので `rc=0` になります。それでも `changed` です。

なぜかというと、shellモジュールはコマンドの実行結果を判定する仕組みを持っていないからです。shellモジュールが知っているのは「コマンドを実行した」「rc=0だった」という2点だけです。「その実行によって状態が変わったかどうか」は、shellモジュールには判断できません。

判断できないので、実行したこと自体を `changed` として報告します。これがshellモジュールのデフォルト動作です。

この動作を実際に確認します。以下の2パターンで検証します。

- **パターンA**：shellモジュールで `mkdir -p` を実行する
- **パターンB**：fileモジュールで同じディレクトリを作成する

パターンAでは、同じPlaybookを2回実行したときの挙動を確認します。1回目でディレクトリが作成された後、2回目の実行でAnsibleがどう報告するかを見ます。

---
### ■検証内容（パターンA：shellモジュール）

【コントローラーノード側】

**ファイル名: test_shell_changed.yml**


```yaml
---
- name: shellモジュールの changed 動作確認
  hosts: test_servers
  gather_facts: false

  tasks:
    - name: ディレクトリを作成する（shell）
      ansible.builtin.shell: mkdir -p /tmp/sample_shell
```

#### ■ 1回目の実行

**実行コマンド**


```plain
ansible-playbook -i inventory.ini test_shell_changed.yml
```

**▼  1回目の実行結果**


```plaintext
PLAY [shellモジュールの changed 動作確認] ***************************************************************************************************************************************************

TASK [ディレクトリを作成する（shell）] ******************************************************************************************************************************************************
changed: [192.168.1.22]
changed: [192.168.1.21]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【 1回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）


```plaintext
[ansibleuser@localhost ~]$ ls -ld /tmp/sample_shell
drwxr-xr-x. 2 ansibleuser ansibleuser 6  6月 16 09:45 /tmp/sample_shell
```

- リモートノード2（192.168.1.22）


```plaintext
[ansibleuser2@localhost ~]$ ls -ld /tmp/sample_shell
drwxr-xr-x. 2 ansibleuser2 ansibleuser2 6  6月 16 09:45 /tmp/sample_shell
```

#### ■ 2回目の実行

**実行コマンド**


```plaintext
ansible-playbook -i inventory.ini test_shell_changed.yml
```

**▼ 2回目の実行結果**


```plaintext
PLAY [shellモジュールの changed 動作確認] ***************************************************************************************************************************************************

TASK [ディレクトリを作成する（shell）] ******************************************************************************************************************************************************
changed: [192.168.1.21]
changed: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ ls -ld /tmp/sample_shell
drwxr-xr-x. 2 ansibleuser ansibleuser 6  6月 16 09:45 /tmp/sample_shell
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ ls -ld /tmp/sample_shell
drwxr-xr-x. 2 ansibleuser2 ansibleuser2 6  6月 16 09:45 /tmp/sample_shell
```

#### ■結果

1回目・2回目ともに、両ノードで `changed=1` となりました。

リモートノード側でディレクトリの状態を確認すると、2回目実行後もタイムスタンプに変化はありませんでした。`/tmp/sample_shell` はすでに存在しており、`mkdir -p` は実質何もしていません。

しかしAnsibleの実行結果は2回目も `changed=1` のままです。shellモジュールはディレクトリが存在するかどうかを確認せずにコマンドを実行するため、「実際に状態が変わったかどうか」を判断できません。実行したこと自体を `changed` として報告するのがshellモジュールのデフォルト動作です。

---

### ■検証内容（パターンB：fileモジュール）

【コントローラーノード側】

**ファイル名: test_file_changed.yml**

```yaml
---
- name: fileモジュールの changed 動作確認
  hosts: test_servers  
  gather_facts: false

  tasks:
    - name: ディレクトリを作成する（file）
      ansible.builtin.file:
        path: /tmp/sample_file
        state: directory
```

#### ■ 1回目の実行

**実行コマンド**


```plaintext
ansible-playbook -i inventory.ini test_file_changed.yml
```

**▼ 1回目の実行結果**


```plaintext
PLAY [fileモジュールの changed 動作確認] ****************************************************************************************************************************************************

TASK [ディレクトリを作成する（file）] *******************************************************************************************************************************************************
changed: [192.168.1.22]
changed: [192.168.1.21]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【1回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）


```plaintext
[ansibleuser@localhost ~]$ ls -ld /tmp/sample_file
drwxr-xr-x. 2 ansibleuser ansibleuser 6  6月 16 10:22 /tmp/sample_file
```

- リモートノード2（192.168.1.22）


```plaintext
[ansibleuser2@localhost ~]$ ls -ld /tmp/sample_file
drwxr-xr-x. 2 ansibleuser2 ansibleuser2 6  6月 16 10:22 /tmp/sample_file
```

---

#### ■ 2回目の実行

**実行コマンド**


```plaintext
ansible-playbook -i inventory.ini test_file_changed.yml
```

**▼ 2回目の実行結果**


```plaintext
PLAY [fileモジュールの changed 動作確認] ****************************************************************************************************************************************************

TASK [ディレクトリを作成する（file）] *******************************************************************************************************************************************************
ok: [192.168.1.21]
ok: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

```

**【2回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ ls -ld /tmp/sample_file
drwxr-xr-x. 2 ansibleuser ansibleuser 6  6月 16 10:22 /tmp/sample_file
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ ls -ld /tmp/sample_file
drwxr-xr-x. 2 ansibleuser2 ansibleuser2 6  6月 16 10:22 /tmp/sample_file
```

---

#### ■結果

1回目は両ノードで `changed=1` となり、ディレクトリが作成されました。2回目は両ノードで `changed=0` となり、タスクは `ok` として報告されました。

リモートノード側でディレクトリの状態を確認すると、2回目実行後もタイムスタンプに変化はありませんでした。fileモジュールは2回目の実行時に `/tmp/sample_file` がすでに存在することを確認し、変更の必要がないと判断しています。そのため何も操作せず、`changed=0` を返しています。

パターンAと比較すると、同じディレクトリ作成という操作でも、shellモジュールは2回目も `changed=1` のままであるのに対し、fileモジュールは2回目に `changed=0` になります。この差は「現在の状態を観測するかどうか」によって生じています。


---

[↑ 目次に戻る](#-目次)

---

## 3. Ansibleモジュールは何を見ているのか

shellモジュールと比較するために、`file` モジュールの動きを見ます。


```yaml
- name: ディレクトリを作成する
  ansible.builtin.file:
    path: /tmp/sample_file
    state: directory
```

このタスクは、`/tmp/sample_file` がすでに存在していれば `ok` になります。2回目の実行で `changed=0` になります。

`file` モジュールの内部では、以下の順序で処理が行われています。

1. 現在の状態を取得する（`/tmp/sample_file` は存在するか、パーミッションは何か、など）
2. 指定された `state: directory` と比較する
3. 差分がなければ変更しない
4. 差分があれば必要な操作だけを行う

shellモジュールとの違いは、「現在の状態を取得する」というステップがあるかどうかです。`file` モジュールはファイルシステムを観測してから動きます。shellモジュールにはその観測ステップがありません。

---

[↑ 目次に戻る](#-目次)

---

## 4. shellモジュールは「状態」を知らない

shellモジュールに渡せる情報は、コマンド文字列だけです。


```yaml
ansible.builtin.shell: useradd testuser
```

このタスクを実行しても、shellモジュールは以下のことを知りません。

- `testuser` がすでに存在するかどうか
- 存在する場合、UIDやグループが想定と一致しているかどうか
- 実行後に状態が変わったかどうか

shellモジュールが行うのは「コマンドを実行する」という操作だけです。実行前の状態も、実行後の状態も、shellモジュールの関与するところではありません。

これは欠陥ではなく、shellモジュールの設計そのものです。shellモジュールはコマンドをそのまま実行するためのモジュールです。状態を管理するためのモジュールではありません。

---

[↑ 目次に戻る](#-目次)

---

## 5. desired stateを持てるモジュール、持てないモジュール

モジュールごとの違いを整理します。

|モジュール|desired stateを持てるか|
|---|---|
|`file`|持てる|
|`user`|持てる|
|`yum` / `dnf`|持てる|
|`shell`|持てない|
|`command`|持てない|

`file` モジュールで `state: directory` と書くとき、これは「このパスがディレクトリである状態にしろ」という宣言です。モジュールはその宣言を受け取り、現在の状態と比較します。

`shell` モジュールで `mkdir -p /tmp/sample` と書くとき、これは「このコマンドを実行しろ」という指示です。「どういう状態であるべきか」は表現されていません。

宣言型のモジュールは desired state を持ちます。shellモジュールは操作の指示を受け取るだけです。この構造の違いが、冪等性の有無につながっています。

---

[↑ 目次に戻る](#-目次)

---

## 6. 「成功した」と「状態が変わった」は別である

冪等性を議論するうえで、よくある誤解を一つ整理しておきます。

```yaml
- name: nginx を再起動する
  ansible.builtin.shell: systemctl restart nginx
```

このタスクは、nginxが動いている限り毎回成功します（`rc=0`）。しかし毎回 `changed=1` になりますし、毎回nginxが再起動されます。

`rc=0` は「コマンドがエラーを返さなかった」という意味です。「状態が変わらなかった」という意味ではありません。nginxの再起動は、プロセスIDが変わり、既存の接続が切れ、ログに記録が残ります。1回目の実行と2回目の実行で、システムの状態は同じではありません。

冪等性の確認は「成功したか（rc=0か）」ではなく「2回目の実行で状態が変化しなかったか」で判定します。成功と冪等は別の概念です。

---

[↑ 目次に戻る](#-目次)

---

## 7. なぜshellは構造的に冪等判定できないのか

shellモジュールの入出力を整理すると、次のようになります。

```
入力: コマンド文字列
出力: stdout / stderr / rc
```

これだけです。

冪等判定を行うには「現在の状態」「目標の状態」「その差分」という3つの情報が必要です。shellモジュールはこのいずれも持ちません。コマンドを実行して、その結果（stdout/stderr/rc）を返すだけです。

冪等なモジュールは「変更する前に観測する」という処理を内部に持っています。shellモジュールはそういう構造になっていません。渡されたコマンドをそのまま実行するだけです。

つまり、shellモジュールに冪等判定を期待することは、構造的に無理です。「shellの使い方が悪い」という話ではなく、shellモジュールはそういう設計のツールではない、ということです。

---

[↑ 目次に戻る](#-目次)

---

## 8. changed_whenは冪等性を保証しているのか

shellモジュールが毎回 `changed=1` になることへの対処として、`changed_when` がよく使われます。


```yaml
- name: nginx を再起動する
  ansible.builtin.shell: systemctl restart nginx
  changed_when: false
```

これを実行すると、結果は `changed=0` になります。`ok` として報告されます。

では、これで冪等になったと言えるでしょうか。

`changed_when: false` を付けたことで変わったのは、Ansibleが報告する表示だけです。nginxは相変わらず再起動されています。プロセスIDは変わります。接続は切れます。状態は変化しています。

`changed=0` という表示が出ても、実際の動作は何も変わっていません。

---

[↑ 目次に戻る](#-目次)

---

## 9. changed_whenが「表示制御」に過ぎない理由

`changed_when` はAnsibleが `changed` を報告するかどうかを制御するオプションです。「状態が変わったかどうか」を判定するオプションではありません。


```yaml
- name: nginx を再起動する
  ansible.builtin.shell: systemctl restart nginx
  changed_when: false
```

このタスクを実行した場合の動作を整理します。

- nginxは再起動される
- `changed=0` として報告される

`changed_when: false` はAnsibleの出力表示を変えます。システムの動作は変えません。

`file` モジュールが `ok` を返す場合と、shellモジュールに `changed_when: false` を付けて `ok` を返す場合は、同じ表示でも意味が違います。前者は「観測した結果、変更の必要がなかった」です。後者は「実際には変更が起きたが、それを changed として報告しないよう設定した」です。

表示と実態が一致していないとも言えます。

この動作を実際に確認します。検証前にリモートノード側でnginxを起動しておきます。

**【事前確認】リモートノード側のnginx起動**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ sudo systemctl start nginx
[root@localhost ~]# systemctl status nginx
● nginx.service - The nginx HTTP and reverse proxy server
     Loaded: loaded (/usr/lib/systemd/system/nginx.service; disabled; preset: disabled)
     Active: active (running) since Tue 2026-06-16 12:06:28 JST; 1min 35s ago
    Process: 4334 ExecStartPre=/usr/bin/rm -f /run/nginx.pid (code=exited, status=0/SUCCESS)
    Process: 4335 ExecStartPre=/usr/sbin/nginx -t (code=exited, status=0/SUCCESS)
    Process: 4337 ExecStart=/usr/sbin/nginx (code=exited, status=0/SUCCESS)
   Main PID: 4338 (nginx)
      Tasks: 5 (limit: 10627)
     Memory: 4.9M (peak: 5.0M)
        CPU: 73ms
     CGroup: /system.slice/nginx.service
             ├─4338 "nginx: master process /usr/sbin/nginx"
             ├─4339 "nginx: worker process"
             ├─4340 "nginx: worker process"
             ├─4341 "nginx: worker process"
             └─4342 "nginx: worker process"

 6月 16 12:06:28 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 12:06:28 localhost.localdomain nginx[4335]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 12:06:28 localhost.localdomain nginx[4335]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 12:06:28 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```



- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo systemctl start nginx
[root@localhost ~]# systemctl status nginx
● nginx.service - The nginx HTTP and reverse proxy server
     Loaded: loaded (/usr/lib/systemd/system/nginx.service; disabled; preset: disabled)
     Active: active (running) since Tue 2026-06-16 12:06:35 JST; 5min ago
    Process: 3798 ExecStartPre=/usr/bin/rm -f /run/nginx.pid (code=exited, status=0/SUCCESS)
    Process: 3799 ExecStartPre=/usr/sbin/nginx -t (code=exited, status=0/SUCCESS)
    Process: 3800 ExecStart=/usr/sbin/nginx (code=exited, status=0/SUCCESS)
   Main PID: 3801 (nginx)
      Tasks: 5 (limit: 10635)
     Memory: 5.0M (peak: 5.2M)
        CPU: 58ms
     CGroup: /system.slice/nginx.service
             ├─3801 "nginx: master process /usr/sbin/nginx"
             ├─3802 "nginx: worker process"
             ├─3803 "nginx: worker process"
             ├─3804 "nginx: worker process"
             └─3805 "nginx: worker process"

 6月 16 12:06:35 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 12:06:35 localhost.localdomain nginx[3799]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 12:06:35 localhost.localdomain nginx[3799]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 12:06:35 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```


---

### ■検証内容（changed_when: false の挙動確認）

【コントローラーノード側】

**ファイル名: test_changed_when.yml**


```yaml
---
- name: changed_when の挙動確認
  hosts: test_servers
  gather_facts: false
  become: true

  tasks:
    - name: nginx を再起動する
      ansible.builtin.shell: systemctl restart nginx
      changed_when: false
```

---

#### ■ 1回目の実行

**実行コマンド**


```plaintext
ansible-playbook -i inventory.ini test_changed_when.yml
```

**▼ 1回目の実行結果**


```plaintext
PLAY [changed_when の挙動確認] **************************************************************************************************************************************************************

TASK [nginx を再起動する] *******************************************************************************************************************************************************************
ok: [192.168.1.21]
ok: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【1回目のリモートノード側の確認】**

nginxが再起動されたことをjournalctlで確認します。

- リモートノード1（192.168.1.21）

```plaintext
[root@localhost ~]# journalctl -u nginx -n 20
 6月 16 11:59:54 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 16 11:59:54 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 16 11:59:54 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 11:59:54 localhost.localdomain nginx[4227]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 11:59:54 localhost.localdomain nginx[4227]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 11:59:54 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 16 12:06:27 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 16 12:06:27 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 16 12:06:27 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 16 12:06:28 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 12:06:28 localhost.localdomain nginx[4335]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 12:06:28 localhost.localdomain nginx[4335]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 12:06:28 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 16 12:13:59 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 16 12:13:59 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 16 12:13:59 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 16 12:13:59 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 12:13:59 localhost.localdomain nginx[4584]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 12:13:59 localhost.localdomain nginx[4584]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 12:13:59 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```

- リモートノード2（192.168.1.22）


```plaintext
[root@localhost ~]# journalctl -u nginx -n 20
 6月 16 11:59:55 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 16 11:59:55 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 16 11:59:55 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 11:59:55 localhost.localdomain nginx[3739]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 11:59:55 localhost.localdomain nginx[3739]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 11:59:55 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 16 12:06:35 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 16 12:06:35 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 16 12:06:35 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 16 12:06:35 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 12:06:35 localhost.localdomain nginx[3799]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 12:06:35 localhost.localdomain nginx[3799]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 12:06:35 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 16 12:14:00 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 16 12:14:00 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 16 12:14:00 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 16 12:14:00 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 12:14:00 localhost.localdomain nginx[3999]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 12:14:00 localhost.localdomain nginx[3999]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 12:14:00 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```

---

#### ■ 2回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_changed_when.yml
```

**▼ 2回目の実行結果**

```plaintext
(ansible) [ansible@localhost workspace]$ ansible-playbook -i inventory.ini test_changed_when.yml

PLAY [changed_when の挙動確認] **************************************************************************************************************************************************************

TASK [nginx を再起動する] *******************************************************************************************************************************************************************
ok: [192.168.1.21]
ok: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[root@localhost ~]# journalctl -u nginx -n 20
 6月 16 12:06:27 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 16 12:06:27 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 16 12:06:28 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 12:06:28 localhost.localdomain nginx[4335]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 12:06:28 localhost.localdomain nginx[4335]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 12:06:28 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 16 12:13:59 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 16 12:13:59 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 16 12:13:59 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 16 12:13:59 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 12:13:59 localhost.localdomain nginx[4584]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 12:13:59 localhost.localdomain nginx[4584]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 12:13:59 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 16 12:15:24 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 16 12:15:24 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 16 12:15:24 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 16 12:15:24 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 12:15:24 localhost.localdomain nginx[4821]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 12:15:24 localhost.localdomain nginx[4821]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 12:15:24 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
[root@localhost ~]#
```

- リモートノード2（192.168.1.22）

```plaintext
[root@localhost ~]# journalctl -u nginx -n 20
 6月 16 12:06:35 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 16 12:06:35 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 16 12:06:35 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 12:06:35 localhost.localdomain nginx[3799]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 12:06:35 localhost.localdomain nginx[3799]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 12:06:35 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 16 12:14:00 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 16 12:14:00 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 16 12:14:00 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 16 12:14:00 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 12:14:00 localhost.localdomain nginx[3999]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 12:14:00 localhost.localdomain nginx[3999]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 12:14:00 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
 6月 16 12:15:25 localhost.localdomain systemd[1]: Stopping The nginx HTTP and reverse proxy server...
 6月 16 12:15:25 localhost.localdomain systemd[1]: nginx.service: Deactivated successfully.
 6月 16 12:15:25 localhost.localdomain systemd[1]: Stopped The nginx HTTP and reverse proxy server.
 6月 16 12:15:25 localhost.localdomain systemd[1]: Starting The nginx HTTP and reverse proxy server...
 6月 16 12:15:25 localhost.localdomain nginx[4224]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
 6月 16 12:15:25 localhost.localdomain nginx[4224]: nginx: configuration file /etc/nginx/nginx.conf test is successful
 6月 16 12:15:25 localhost.localdomain systemd[1]: Started The nginx HTTP and reverse proxy server.
```

---

#### ■結果

1回目・2回目ともに、Ansibleの出力は `changed=0` となり、タスクは `ok` として報告されました。

しかしjournalctlを確認すると、1回目の実行（12:13〜12:14）、2回目の実行（12:15）のそれぞれでnginxのStop→Startが記録されています。Ansibleの表示上は `ok` であるにもかかわらず、nginxは毎回再起動されています。

`changed_when: false` によって変わったのはAnsibleの報告だけです。システム上では毎回nginxが再起動されており、状態は変化し続けています。`changed=0` という表示は「状態が変わらなかった」ことを意味しておらず、「changedとして報告しない設定になっている」ことを意味しているに過ぎません。

---

[↑ 目次に戻る](#-目次)

---

## 10. 「差分検出」と「表示上の補正」は何が違うのか

冪等なモジュールと `changed_when` の違いを整理します。

**冪等なモジュール（例：`file`）**

1. 現在の状態を観測する
2. desired stateと比較する
3. 差分がなければ何もしない → `ok`
4. 差分があれば変更する → `changed`

この場合の `ok` は「状態が収束している」という実態を反映しています。

**shellモジュール + `changed_when: false`**

1. コマンドを実行する
2. 状態が変わったかどうかにかかわらず `ok` として報告する

この場合の `ok` は「実態はわからないが、changed とは表示しない」という設定の結果です。

`changed_when` は `changed` の報告を制御するものです。差分を検出する仕組みを追加するものではありません。

---

[↑ 目次に戻る](#-目次)

---

## 11. shellモジュールを使っても良いケース

ここまでの話を踏まえて、shellモジュールが適切な用途を整理しておきます。

shellモジュールは「状態管理ができない」というだけで、「使ってはいけない」わけではありません。状態管理が必要でない用途では問題なく使えます。

**適切な用途の例**

- 対応するモジュールが存在しない操作
- 一時的な調査やデバッグ（読み取り専用のコマンド）
- 何かを確認して結果を `register` で受け取る場合
- 一度だけ実行することが前提のマイグレーション処理
- モジュールが存在しない外部コマンドの呼び出し

ただし、これらの用途でshellモジュールを使う場合も、「状態管理ではなく手続き実行をしている」という認識を持っておくことが重要です。そのタスクが冪等でないことを意識した上で、Playbookの設計を考える必要があります。

`when` 条件を使って「特定の状態のときだけ実行する」という構成にすれば、shellモジュールを使いながらも冪等に近い動きを実現できる場合があります。ただし、その場合の冪等性はshellモジュール自体ではなく、`when` 条件の設計によって担保されています。

>なお、shellモジュールには冪等性とは別の観点での問題もあります。Shell経由でのコマンド実行における引数の解釈や安全性については、以下の記事で取り上げています。
>
→ **[Ansibleが理解できない理由はLinuxにあった 【Ansible編】第2回：なぜmoduleを使うと安全になるのか](https://qiita.com/juehara-crypto/items/add27cf65c5a80104522)**

---

[↑ 目次に戻る](#-目次)

---

## 12. まとめ

この回で整理した内容を確認します。

- **shellモジュールはコマンドを実行するモジュールである**。現在の状態を観測する仕組みを持っていない。
- **冪等判定には「現在の状態」「desired state」「差分」が必要**。shellモジュールはこの3つを持たない。
- **`rc=0` は冪等性を意味しない**。「成功した」と「状態が変わらなかった」は別の話である。
- **`changed_when` は表示を制御するものであり、状態遷移を止めるものではない**。`changed=0` になっても、実際の動作は変わらない。
- **冪等なモジュールの `ok` と、`changed_when: false` を付けた `ok` は意味が違う**。前者は差分検出の結果、後者は表示上の設定の結果である。

shellモジュールは「危険」なのではありません。そもそも「状態管理をする構造」を持っていないツールです。その認識を持った上で使うか、対応するモジュールに置き換えるかを判断することが、冪等な設計の出発点になります。

---

[↑ 目次に戻る](#-目次)

---

📑 連載の移動　**[前の記事：【冪等性編】 第0回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-00/)　｜　[次の記事：【冪等性編】 第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-02/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 シリーズまとめブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---


## 13. 連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 

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
| 第9回  | 冪等性はどうやって検証すべきなのか               | check mode の限界、diff mode、molecule、CI、自動テストを通して、「2回目 changed=0」をどう保証するのかを理解する。                        |
| 第10回 | 「冪等に設計する」とは何を設計することなのか          | imperative（手続き）ではなく declarative（状態宣言）としてPlaybookを設計する考え方を整理し、「壊れない構成管理」の原則を完成させる。                    |


---

[↑ 目次に戻る](#-目次)

---
