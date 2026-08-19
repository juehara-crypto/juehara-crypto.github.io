---
title: '「Ansibleは冪等なのに、なぜサーバは壊れていくのか」 第1回：なぜ手動変更はAnsibleの管理を壊すのか'
description: '障害対応や一時的な直接編集がドリフトを生む構造を、`template`と`lineinfile`の挙動の違いを通して理解する。手動変更が「次にAnsibleが実行されるまで気づかれない」空白を作ることを整理する。'
pubDate: '2026-07-30'
category: 'infra'
tags: ['Ansible', 'ドリフト', '構成管理', 'template', 'lineinfile', '手動変更']
seriesId: 'ansible-drift'
seriesNo: 1
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-00/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/'
relatedSeries: ''
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



> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansibleは冪等なのに、なぜサーバは壊れていくのか」シリーズまとめブログ**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [手動変更はなぜ発生するのか](#2-手動変更はなぜ発生するのか)
3. [Ansibleが管理しているファイルを手動で書き換えると何が起きるか](#3-ansibleが管理しているファイルを手動で書き換えると何が起きるか)
4. [templateモジュールは差分を検出して上書きする](#4-templateモジュールは差分を検出して上書きする)
5. [lineinfileはドリフトの痕跡を残す](#5-lineinfileはドリフトの痕跡を残す)
6. [「次にAnsibleが実行されるまで気づかれない」という時間的な空白](#6-次にansibleが実行されるまで気づかれないという時間的な空白)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「Ansibleは冪等なのに、なぜサーバは壊れていくのか」](#9-連載一覧ansibleは冪等なのになぜサーバは壊れていくのか)
---

## 1. はじめに

**[第0回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-00/)** では、Ansibleにおける構成ドリフトの定義と発生経路の全体像を整理しました。手動変更・Ansible以外のツールによる変更・パッケージの自動更新・ソフトウェアの自己書き換えという4つの経路を挙げましたが、第1回はその中で最も頻繁に起きる「手動変更」を詳しく扱います。

「障害対応で緊急に設定を変更した」「一時的に変えたつもりが戻し忘れた」という経験は、どの現場でも発生します。このとき何が起きているのかを、構造から整理します。

この回は手動変更そのものの是非を問う回ではありません。手動変更が起きたとき、Ansibleとの関係でどういう問題が発生するかを構造として理解することが目的です。

---

[↑ 目次に戻る](#-目次)

---

## 2. 手動変更はなぜ発生するのか

手動変更が現場で避けられない理由を整理します。「手動変更は禁止すればよい」という運用論の話ではなく、「起きることを前提にその影響を把握する」という視点で整理します。

手動変更が発生する主な場面には、次のようなものがあります。

- 障害対応で緊急に設定を変更する必要があり、Playbookを修正・反映する時間がない
- 一時的な設定変更のつもりが、戻し忘れた
- Ansible管理外の担当者がサーバを直接操作した
- Playbookが整備される前に、手動で構築された設定が残っている

Ansibleで管理していても手動変更は起きます。この前提に立つことが、ドリフト対策の出発点になります。

---

[↑ 目次に戻る](#-目次)

---

## 3. Ansibleが管理しているファイルを手動で書き換えると何が起きるか

手動変更が発生した直後・Playbook再実行時・再実行までの空白期間という3つのタイミングで、何が起きるかを整理します。

|タイミング|何が起きるか|
|---|---|
|手動変更直後|サーバの状態はdesired stateからずれた状態になる|
|Playbook再実行時|モジュールによって動作が異なる(次のセクションで詳述)|
|再実行までの空白期間|ドリフトが検知されないまま進む|

手動変更そのものよりも、「次のPlaybook実行まで気づかれない」という時間的な空白が問題になります。この点を次のセクション以降の検証で確認します。

---

[↑ 目次に戻る](#-目次)

---

## 4. templateモジュールは差分を検出して上書きする

Ansibleが管理しているファイルを手動で書き換えた後に、templateモジュールを含むPlaybookを再実行すると、差分が検出されて上書きされます。この動作を検証で確認します。


```plaintext
【事前確認（1回目の実行）】
↓
【手動設定】
↓
【2回目の実行】
```
の順に検証します。事前確認で現状とdesired stateが一致していることを示すことで、手動変更だけが唯一の変化点であることを明確にします。



### ■ 検証内容（templateモジュール管理下のファイルに対する手動変更後の再実行：正当な緊急対応が黙って消されるケース）

#### 【事前確認（1回目の実行）】

【コントローラーノード側】
**ファイル名:** playbooks/configure_nginx.yml
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

**テンプレート:** templates/nginx.conf.j2
```plaintext
user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
        worker_connections {{ nginx_worker_connections }};
        # multi_accept on;
}

http {
        ##
        # Basic Settings
        ##
        sendfile on;
        tcp_nopush on;
        types_hash_max_size 2048;
        include /etc/nginx/mime.types;
        default_type application/octet-stream;
        ##
        # SSL Settings
        ##
        ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3;
        ssl_prefer_server_ciphers on;
        ##
        # Logging Settings
        ##
        access_log /var/log/nginx/access.log;
        error_log /var/log/nginx/error.log;
        ##
        # Gzip Settings
        ##
        gzip on;
        ##
        # Virtual Host Configs
        ##
        include /etc/nginx/conf.d/*.conf;
        include /etc/nginx/sites-enabled/*;
}
```
（コメントアウト行の一部は紙面の都合上省略。実ファイルと完全一致するテンプレートを使用）

**実行コマンド**
```plaintext
ansible-playbook -i inventory.ini playbooks/configure_nginx.yml
```

**▼ 実行結果**

```plaintext
PLAY [Configure nginx worker settings] ******************************************************************************************************************************************************

TASK [nginx.confをtemplateで配置する] *******************************************************************************************************************************************************
ok: [ubuntu-node2]
ok: [ubuntu-node1]
ok: [ubuntu-node3]

PLAY RECAP **********************************************************************************************************************************************************************************
ubuntu-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
ubuntu-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
ubuntu-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

```


【リモートノード側】
以下の通り、ファイルが配置済み（desired stateと一致）であることを確認済み

・ubuntu-node1（192.168.56.31）
```plaintext
control@ubuntu-node1:~$ cat /etc/nginx/nginx.conf
user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
        worker_connections 768;
        # multi_accept on;
}

http {
        ##
        # Basic Settings
        ##
        sendfile on;
        tcp_nopush on;
        types_hash_max_size 2048;
        # server_tokens off;
        # server_names_hash_bucket_size 64;
        # server_name_in_redirect off;
        include /etc/nginx/mime.types;
        default_type application/octet-stream;
        ##
        # SSL Settings
        ##
        ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3; # Dropping SSLv3, ref: POODLE
        ssl_prefer_server_ciphers on;
        ##
        # Logging Settings
        ##
        access_log /var/log/nginx/access.log;
        error_log /var/log/nginx/error.log;
        ##
        # Gzip Settings
        ##
        gzip on;
        # gzip_vary on;
        # gzip_proxied any;
        # gzip_comp_level 6;
        # gzip_buffers 16 8k;
        # gzip_http_version 1.1;
        # gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
        ##
        # Virtual Host Configs
        ##
        include /etc/nginx/conf.d/*.conf;
        include /etc/nginx/sites-enabled/*;
}
#mail {
#       # See sample authentication script at:
#       # http://wiki.nginx.org/ImapAuthenticateWithApachePhpScript
#
#       # auth_http localhost/auth.php;
#       # pop3_capabilities "TOP" "USER";
#       # imap_capabilities "IMAP4rev1" "UIDPLUS";
#
#       server {
#               listen     localhost:110;
#               protocol   pop3;
#               proxy      on;
#       }
#
#       server {
#               listen     localhost:143;
#               protocol   imap;
#               proxy      on;
#       }
#}
control@ubuntu-node1:~$
```

・ubuntu-node2（192.168.56.32）
```plaintext
control@ubuntu-node2:~$  cat /etc/nginx/nginx.conf
user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
        worker_connections 768;
        # multi_accept on;
}

http {
        ##
        # Basic Settings
        ##
        sendfile on;
        tcp_nopush on;
        types_hash_max_size 2048;
        # server_tokens off;
        # server_names_hash_bucket_size 64;
        # server_name_in_redirect off;
        include /etc/nginx/mime.types;
        default_type application/octet-stream;
        ##
        # SSL Settings
        ##
        ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3; # Dropping SSLv3, ref: POODLE
        ssl_prefer_server_ciphers on;
        ##
        # Logging Settings
        ##
        access_log /var/log/nginx/access.log;
        error_log /var/log/nginx/error.log;
        ##
        # Gzip Settings
        ##
        gzip on;
        # gzip_vary on;
        # gzip_proxied any;
        # gzip_comp_level 6;
        # gzip_buffers 16 8k;
        # gzip_http_version 1.1;
        # gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
        ##
        # Virtual Host Configs
        ##
        include /etc/nginx/conf.d/*.conf;
        include /etc/nginx/sites-enabled/*;
}
#mail {
#       # See sample authentication script at:
#       # http://wiki.nginx.org/ImapAuthenticateWithApachePhpScript
#
#       # auth_http localhost/auth.php;
#       # pop3_capabilities "TOP" "USER";
#       # imap_capabilities "IMAP4rev1" "UIDPLUS";
#
#       server {
#               listen     localhost:110;
#               protocol   pop3;
#               proxy      on;
#       }
#
#       server {
#               listen     localhost:143;
#               protocol   imap;
#               proxy      on;
#       }
#}
control@ubuntu-node2:~$
```

・ubuntu-node3（192.168.56.33）
```plaintext
control@ubuntu-node3:~$ cat /etc/nginx/nginx.conf
user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
        worker_connections 768;
        # multi_accept on;
}

http {
        ##
        # Basic Settings
        ##
        sendfile on;
        tcp_nopush on;
        types_hash_max_size 2048;
        # server_tokens off;
        # server_names_hash_bucket_size 64;
        # server_name_in_redirect off;
        include /etc/nginx/mime.types;
        default_type application/octet-stream;
        ##
        # SSL Settings
        ##
        ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3; # Dropping SSLv3, ref: POODLE
        ssl_prefer_server_ciphers on;
        ##
        # Logging Settings
        ##
        access_log /var/log/nginx/access.log;
        error_log /var/log/nginx/error.log;
        ##
        # Gzip Settings
        ##
        gzip on;
        # gzip_vary on;
        # gzip_proxied any;
        # gzip_comp_level 6;
        # gzip_buffers 16 8k;
        # gzip_http_version 1.1;
        # gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
        ##
        # Virtual Host Configs
        ##
        include /etc/nginx/conf.d/*.conf;
        include /etc/nginx/sites-enabled/*;
}
#mail {
#       # See sample authentication script at:
#       # http://wiki.nginx.org/ImapAuthenticateWithApachePhpScript
#
#       # auth_http localhost/auth.php;
#       # pop3_capabilities "TOP" "USER";
#       # imap_capabilities "IMAP4rev1" "UIDPLUS";
#
#       server {
#               listen     localhost:110;
#               protocol   pop3;
#               proxy      on;
#       }
#
#       server {
#               listen     localhost:143;
#               protocol   imap;
#               proxy      on;
#       }
#}
control@ubuntu-node3:~$
```

---

#### 【手動設定】
ubuntu-node1上で、障害対応を想定し`worker_connections`を手動で書き換える

実行コマンド：
```plaintext
sudo sed -i 's/worker_connections 768;/worker_connections 2048;/' /etc/nginx/nginx.conf
sudo systemctl reload nginx
```

変更前のファイル内容（該当行）：
```plaintext
events {
        worker_connections 768;
        # multi_accept on;
}
```

変更後のファイル内容（該当行）：
```plaintext
events {
        worker_connections 2048;
        # multi_accept on;
}
```

---

#### 【2回目の実行】

実行コマンド：
```plaintext
ansible-playbook -i inventory.ini playbooks/configure_nginx.yml
```

**▼ 実行結果**
```plaintext
PLAY [Configure nginx worker settings] ******************************************************************************************************************************************************

TASK [nginx.confをtemplateで配置する] *******************************************************************************************************************************************************
ok: [ubuntu-node3]
ok: [ubuntu-node2]
changed: [ubuntu-node1]

RUNNING HANDLER [reload nginx] **************************************************************************************************************************************************************
changed: [ubuntu-node1]

PLAY RECAP **********************************************************************************************************************************************************************************
ubuntu-node1               : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
ubuntu-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
ubuntu-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```


【リモートノード側】
・ubuntu-node1（192.168.56.31）

**※2回目実行後のファイル内容（該当行）：**

```plaintext
events {
        worker_connections 768;
        # multi_accept on;
}
```

---

#### ■ 結果

2回目の実行では、手動変更を加えたubuntu-node1のみ`changed=2`（templateタスクの適用とhandlerによるnginxのreload）となり、変更を加えていないubuntu-node2・ubuntu-node3は`changed=0`のままでした。

リモートノード側で`/etc/nginx/nginx.conf`を確認すると、ubuntu-node1の`worker_connections`は`768`に戻っており、手動で設定した`2048`は消えていました。

この結果から、templateモジュールは手動変更が加えられたノードだけを検出して上書きし、変更のないノードには手を加えないことが分かります。同時に、実行結果の`changed=2`という表示だけでは、その変更が「戻し忘れの修正」だったのか「意図的な緊急対応の無効化」だったのかを区別できません。手動変更の中身がどのような意図であったかは、Playbookの実行結果には一切現れないという点が、この検証で確認できたことです。

---

[↑ 目次に戻る](#-目次)

---

## 5. lineinfileはドリフトの痕跡を残す

同じく手動変更後のPlaybook再実行を検証しますが、今度はlineinfileモジュールを使っているケースを取り上げます。

冪等性シリーズ第6回で、lineinfileは「局所パッチ」として動作することを確認しました。この特性が、ドリフトの文脈でどう現れるかを整理します。

```plaintext
【事前確認（1回目の実行）】
↓
【手動設定】
↓
【2回目の実行】
```

の順に検証します。lineinfileが管理している行と、管理していない行の両方に手動変更を加え、2回目の実行でどちらが修正され、どちらが残るかを確認します。

---

### ■ 検証内容（lineinfileモジュール管理下の行と、管理外の行に対する手動変更後の再実行）

#### 【事前確認（1回目の実行）】

【コントローラーノード側】  
**ファイル名:** playbooks/configure_nginx_worker_processes.yml

```yaml
---
- name: Configure nginx worker_processes (lineinfile)
  hosts: nodes
  become: true
  gather_facts: false
  tasks:
    - name: worker_processesの値を管理する
      ansible.builtin.lineinfile:
        path: /etc/nginx/nginx.conf
        regexp: '^worker_processes\s+.*;'
        line: 'worker_processes auto;'
      notify: reload nginx

  handlers:
    - name: reload nginx
      ansible.builtin.systemd:
        name: nginx
        state: reloaded
```

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini playbooks/configure_nginx_worker_processes.yml
```

**▼ 実行結果**

```plaintext
PLAY [Configure nginx worker_processes (lineinfile)] ****************************************************************************************************************************************

TASK [worker_processesの値を管理する] *******************************************************************************************************************************************************
ok: [ubuntu-node1]
ok: [ubuntu-node2]
ok: [ubuntu-node3]

PLAY RECAP **********************************************************************************************************************************************************************************
ubuntu-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
ubuntu-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
ubuntu-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【リモートノード側】**  
・ubuntu-node1（192.168.56.31）

**※以下、/etc/nginx/nginx.confファイルの内容**

- lineinfile管理下の行：
```plaintext
worker_processes auto;
```

- lineinfile管理外の行：
```plaintext
        # multi_accept on;
```

---

#### 【手動設定】

ubuntu-node1上で、以下の2箇所を同時に手動変更する

- lineinfile管理下の行：`worker_processes auto;` → `worker_processes 4;`（緊急対応でワーカー数を固定した想定）
- lineinfile管理外の行：`# multi_accept on;` のコメントを外す

実行コマンド：

```plaintext
sudo sed -i 's/^worker_processes auto;/worker_processes 4;/' /etc/nginx/nginx.conf
sudo sed -i 's/^        # multi_accept on;/        multi_accept on;/' /etc/nginx/nginx.conf
sudo systemctl reload nginx
```

変更前のファイル内容（該当行）：

```plaintext
worker_processes auto;
...
        # multi_accept on;
```

変更後のファイル内容（該当行）：

```plaintext
worker_processes 4;
...
        multi_accept on;
```

---

#### 【2回目の実行】

実行コマンド：

```plaintext
ansible-playbook -i inventory.ini playbooks/configure_nginx_worker_processes.yml
```

**▼ 実行結果**

```plaintext
PLAY [Configure nginx worker_processes (lineinfile)] ****************************************************************************************************************************************

TASK [worker_processesの値を管理する] *******************************************************************************************************************************************************
changed: [ubuntu-node1]
ok: [ubuntu-node2]
ok: [ubuntu-node3]

RUNNING HANDLER [reload nginx] **************************************************************************************************************************************************************
changed: [ubuntu-node1]

PLAY RECAP **********************************************************************************************************************************************************************************
ubuntu-node1               : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
ubuntu-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
ubuntu-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【リモートノード側】**  
・ubuntu-node1（192.168.56.31）

**※2回目実行後のファイル内容（該当行）：**

```plaintext
worker_processes auto;
...
        multi_accept on; 
```

---

#### ■ 結果


2回目の実行では、手動変更を加えたubuntu-node1のみ`changed=2`となり、変更を加えていないubuntu-node2・ubuntu-node3は`changed=0`のままでした。この点はtemplateモジュールの検証と同じ挙動です。

一方、リモートノード側でubuntu-node1の`/etc/nginx/nginx.conf`を確認すると、`worker_processes`は`auto`に戻っていましたが、`multi_accept on;`のコメント解除はそのまま残っていました。lineinfileが管理しているのは`worker_processes`の行だけであり、`multi_accept`の行はPlaybookの管理範囲外だったためです。

この結果から、lineinfileは管理している行に対してはtemplateと同様に手動変更を検出して修正しますが、管理していない行に対しては一切関知しないことが分かります。実行結果の`changed=2`という表示だけを見ると「ドリフトが解消された」ように見えますが、実際には`multi_accept`の手動変更はファイルに残ったままです。Playbookの実行結果は、あくまで「Playbookが管理している範囲」についての結果であり、ファイル全体の状態を保証するものではないことが、この検証で確認できました。

templateモジュールとlineinfileモジュールの動作の違いを整理します。

|モジュール|手動変更後の再実行での動作|
|---|---|
|template|ファイル全体をdesired stateに戻す。手動変更の痕跡は残らない|
|lineinfile|管理している行だけを修正する。管理外の手動変更は残る|

templateとlineinfileの違いは、どちらが優れているかという話ではありません。templateは手動変更を区別せず上書きするため、それが正当な変更であっても消してしまう可能性があります。lineinfileは逆に、管理外の変更を区別せず残すため、それが不要な変更であっても気づかれないまま残り続ける可能性があります。「Playbookが成功した＝ドリフトが解消された」とは言えないケースがあることが、ここでわかります。

---

[↑ 目次に戻る](#-目次)

---

## 6. 「次にAnsibleが実行されるまで気づかれない」という時間的な空白

セクション4・5の検証を踏まえて、手動変更が問題になる本質的な理由を整理します。

templateモジュールを使っている場合、次の実行で手動変更は消えます。それが戻し忘れであれば安全網として働きますが、意図的な緊急対応であれば、気づかないうちに無効化されてしまいます。

- 手動変更からPlaybook再実行までの間、サーバはdesired stateからずれた状態で動いている
- その間にインシデントが発生しても、「手動変更による設定のずれ」が原因として特定されにくい
- 定期的なPlaybook実行がなければ、その空白は無期限に続く

lineinfileモジュールを使っている場合、管理している行についてはtemplateと同じ空白が生まれます。セクション5の検証で確認した通り、緊急対応で書き換えた`worker_processes`は、次の実行で気づかないうちに元の値に戻されました。

加えて、lineinfileには管理していない行という、templateにはない領域があります。管理外の変更は残り続けるため、それが不要なものであっても、次の実行結果だけでは気づけません。

どちらのケースも、Playbookの実行結果だけを見ていては、実際に何が起きたかを正しく判断できないという点は共通しています。「Ansibleを使っているから安心」ではなく、「次の実行までの間に何かが起きているかもしれない」という意識を持つことが、ドリフト対策の前提になります。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

- 手動変更は現場で避けられない問題であり、発生することを前提に影響を把握する必要がある
- templateモジュールは手動変更を区別せず上書きするため、戻し忘れには安全網として働くが、意図的な変更であれば気づかれないまま無効化される
- lineinfileモジュールは、管理している行についてはtemplateと同じく手動変更を無効化するが、管理していない行についてはそれを区別せず残すため、不要な変更であっても気づかれないまま残り続ける
- 手動変更が危険な本質的な理由は、上書きされる場合もされない場合も、「次のAnsible実行まで気づかれない」という時間的な空白にある

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

次回は、「なぜドリフトは`--check`で検知できないのか」を扱います。

手動変更後のドリフトを確認する手段として`--check`モードを使った場合に、何が分かり、何が分からないのかを整理します。

**[次回：第2回：なぜドリフトは`--check`で検知できないのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)**

---

📑 連載の移動　**[前の記事：【構成ドリフト編】 第0回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-00/)　｜　[次の記事：【構成ドリフト編】 第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansibleは冪等なのに、なぜサーバは壊れていくのか」シリーズまとめブログ**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「Ansibleは冪等なのに、なぜサーバは壊れていくのか」

| 回   | タイトル                          | 内容（概要）                                                                                                                  |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **[第0回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-00/)** | なぜAnsibleで管理しているのにサーバはずれていくのか | 構成ドリフトを「Playbookで定義したdesired stateと実際のサーバの状態がずれていく現象」として定義し、冪等性シリーズとの違いを整理する。ドリフトが「Ansibleが実行されていない時間」に起きる問題であることを理解する。 |
| **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)** | なぜ手動変更はAnsibleの管理を壊すのか        | 障害対応や一時的な直接編集がドリフトを生む構造を、`template`と`lineinfile`の挙動の違いを通して理解する。手動変更が「次にAnsibleが実行されるまで気づかれない」空白を作ることを整理する。              |
| **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** | なぜdriftは`--check`で検知できないのか    | `--check`/`--diff`モードをドリフト検知の手段として使う場合の限界を整理する。検知できるケースと検知できないケースを実機で切り分け、「`--check`で問題が出ない＝ドリフトがない」ではないことを理解する。        |
| **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-03/)** | なぜドリフトは気づかれないまま進むのか           | `changed`が出ない「静かなドリフト」の構造を扱う。cronジョブやアプリケーションの自己書き換え、パッケージの自動更新など、Ansible管理外で起きる変化がPlaybook実行結果に現れない理由を理解する。            |
| **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** | ドリフトを検知して修正する設計               | シリーズの結論として、ドリフトを「防ぐ」「検知する」「修正する」の3つの設計パターンを整理する。定期実行・アラート化・自動修正フローなど、運用に組み込むための具体的な設計を扱う。                               |

---

[↑ 目次に戻る](#-目次)

---

