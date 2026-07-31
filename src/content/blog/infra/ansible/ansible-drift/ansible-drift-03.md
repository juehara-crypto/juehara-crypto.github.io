---
title: '「Ansibleは冪等なのに、なぜサーバは壊れていくのか」  第3回：なぜドリフトは気づかれないまま進むのか'
description: '`changed`が出ない「静かなドリフト」の構造を扱う。cronジョブやアプリケーションの自己書き換え、パッケージの自動更新など、Ansible管理外で起きる変化がPlaybook実行結果に現れない理由を理解する。'
pubDate: '2026-07-31'
category: 'infra'
tags: ['Ansible', 'ドリフト', '構成管理', 'changed=0']
seriesId: 'ansible-drift'
seriesNo: 3
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/'
nextPost: ''
relatedSeries: ''
---


> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「Ansibleは冪等なのに、なぜサーバは壊れていくのか」シリーズまとめブログ** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [changedが出ないドリフトとはどういう状態か](#2-changedが出ないドリフトとはどういう状態か)
3. [changedが出ないドリフトの具体的なパターン](#3-changedが出ないドリフトの具体的なパターン)
4. [「2回実行してchanged=0」という確認でも検知できない](#4-2回実行してchanged0という確認でも検知できない)
5. [Playbookが正常終了していてもドリフトは進む](#5-playbookが正常終了していてもドリフトは進む)
6. [まとめ](#6-まとめ)
7. [次回予告](#7-次回予告)
8. [連載一覧：「Ansibleは冪等なのに、なぜサーバは壊れていくのか」](#8-連載一覧ansibleは冪等なのになぜサーバは壊れていくのか)

---

## 1. はじめに

**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** では、`--check`モードがドリフト検知ツールとして機能するケースと機能しないケースを整理しました。templateモジュールで管理しているファイルの手動変更は`--check`で検知できましたが、shellモジュールが管理している処理、Ansible管理外のファイル・プロセスの変化、パッケージのマイナーアップデートは検知できないことを確認しました。

第3回はその問題をさらに掘り下げます。`--check`だけでなく、「Playbookを通常実行しても`changed=0`のまま通過するドリフト」の存在を整理します。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** が「確認ツールとしての限界」だったのに対して、第3回は「Playbookの実行結果そのものが信頼できない場面」を扱います。

---

[↑ 目次に戻る](#-目次)

---

## 2. changedが出ないドリフトとはどういう状態か

このセクションで扱う「changedが出ない」とは、Playbookの実行結果として`changed=1`が返らず、`changed=0`のまま通過することを指します。ドリフトが実際に発生していても、実行結果にはそれが現れません。

`changed=1`が出るドリフトと、`changed=0`のまま通過するドリフトの違いを整理します。

`changed=1`が出るドリフトは、Playbookを再実行すれば検知・修正されます。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)** で確認したtemplateモジュールによる上書きがその例でした。このタイプのドリフトは、Playbookを定期実行していれば対応できます。

問題はそれよりも、`changed=0`のまま通過するドリフトの存在です。Ansibleはタスクに記述されたdesired stateとリモートノードの現在の状態を比較しますが、タスクに記述されていない要素は比較の対象になりません。この構造上の特性が、「changedが出ないドリフト」を生みます。

2種類のドリフトを表に整理します。

|種類|Playbook実行時の動作|検知されるか|
|---|---|---|
|changedが出るドリフト|差分を検出して`changed=1`を返す|される|
|changedが出ないドリフト|`changed=0`のまま通過する|されない|

「changedが出ないドリフト」が存在するという認識を持つことが、このセクションの到達点です。次のセクションでは、このドリフトが具体的にどのような場面で発生するかを、いずれも`changed=0`のまま通過する例として整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. changedが出ないドリフトの具体的なパターン

Ansibleが管理していない領域で起きる変化として、以下のパターンを整理します。いずれもPlaybookを実行しても`changed=0`のまま通過します。

> **Ansible管理外のcronジョブが設定ファイルを書き換えている**

cronジョブがAnsibleの管理対象外のスクリプトを定期実行し、そのスクリプトが設定ファイルを書き換えている場合です。Playbookにそのファイルを管理するタスクがなければ、`changed=0`のまま通過します。

> **アプリケーションが、Ansibleの管理範囲外の設定項目を起動時に書き換える**

Ansibleがlineinfileモジュールなどで設定ファイルの一部の項目のみを管理しているケースです。同じファイル内に、アプリケーションが起動時に自動生成・更新する別の項目が含まれている場合、その項目はAnsibleのタスクに記述されていないため、比較の対象になりません。Ansibleが管理している項目に変化がなければ、アプリケーションが書き換えた別の項目がどれだけ変化しても`changed=0`のまま通過します。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)** のlineinfile検証で確認した「管理下の行は復元されるが、管理外の行は残り続ける」構造と同じ形です。

> **セキュリティツールが、Ansibleの管理範囲外の属性を変更する**

Ansibleがfileモジュールなどでパーミッション(mode)を管理しているケースです。SELinuxコンテキストやACLなど、パーミッションとは別の属性をセキュリティツールが独自に変更している場合、その属性はAnsibleのタスクに記述されていないため、比較の対象になりません。管理しているmodeに変化がなければ、管理していない別の属性がセキュリティツールによって変更されても`changed=0`のまま通過します。

> **パッケージの自動更新でライブラリのバージョンが上がっている**

`state: present`はパッケージの存在有無のみをdesired stateとして定義しており、バージョンはタスクに記述されていません。そのため、マイナーアップデートでバージョンが上がっても`changed=0`のまま通過します。**[冪等性シリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/)** セクション2「state-presentとstate-latestは何が違うのか」で扱った`state: present`の動作が、ここでも関係します。

これらに共通しているのは、「Playbookのタスクに記述されていない要素は、Ansibleの確認対象にならない」という構造です。ファイルやリソースの一部を管理している場合でも、管理範囲の外で起きる変化には同じ構造が当てはまります。次のセクションでは、この構造が「2回実行してchanged=0になること」という確認手法にどう影響するかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 4. 「2回実行してchanged=0」という確認でも検知できない

**[冪等性シリーズ第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-09/)** セクション2「『2回実行してchanged=0になること』は何を意味するのか」では、「2回実行して`changed=0`になること」をPlaybookの冪等性を確認する手法として整理しました。この確認が成立する前提として、「外部状態が安定していること」と「実行経路が1種類に限られること」の2つが示されています。

ドリフトの文脈ではこれに加えて、もう一つの前提が必要です。「Ansible管理外の変化が発生していないこと」です。2回実行して`changed=0`になったとしても、以下のことは確認されていません。

- Ansible管理外のcronジョブが設定ファイルを書き換えていないこと
- アプリケーションが、Ansible管理範囲外の項目を書き換えていないこと
- セキュリティツールが、Ansible管理範囲外の属性を変更していないこと
- パッケージのマイナーアップデートが発生していないこと

「2回実行して`changed=0`」という確認は、Playbookが管理している範囲に対しては有効ですが、changedが出ないドリフトに対しては機能しません。冪等性の確認とドリフトの不在は、別の話です。

---

[↑ 目次に戻る](#-目次)

---

## 5. Playbookが正常終了していてもドリフトは進む

セクション2〜4の内容を踏まえて、この回の構造的な結論を実機で確認します。

セクション3で整理した4パターンのうち、①(Ansible管理外のcronジョブによる書き換え)を実際に再現します。検証には、**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)**・**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** で使用した`playbooks/configure_nginx_worker_processes.yml`(lineinfileモジュール、`worker_processes`の行のみを管理)をそのまま使用します。このPlaybookは`/etc/nginx/mime.types`には一切言及していません。

```plaintext
1.【事前確認(1回目の実行)】
↓
2.【cronジョブによる自動書き換え】
↓
3.【2回目の実行】
```

の順に検証します。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)**・**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)**の検証がPlaybookで管理しているファイル(の一部)を対象にしていたのに対し、今回は**どのPlaybookのタスクにも一切記述されていないファイル**を対象にする点が、これまでの検証との違いです。

---

### ■ 検証内容(Ansible管理外ファイルへのcronジョブによる書き換えが、Playbook実行で検知されるか)

#### 1.【事前確認(1回目の実行)】

【コントローラーノード側】  
**ファイル名:** playbooks/configure_nginx_worker_processes.yml(**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)**・**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** で使用したものと同一)

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini playbooks/configure_nginx_worker_processes.yml
```

**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)**・**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** の検証で全ノードのdesired stateへの復元が確認済みのため、ここでは`changed=0`になることの再確認のみ行います。

**▼ 実行結果**

```
PLAY [Configure nginx worker_processes (lineinfile)] ****************************************************************************************************************************************

TASK [worker_processesの値を管理する] *******************************************************************************************************************************************************
ok: [ubuntu-node1]
ok: [ubuntu-node3]
ok: [ubuntu-node2]

PLAY RECAP **********************************************************************************************************************************************************************************
ubuntu-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
ubuntu-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
ubuntu-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

【リモートノード側】

ubuntu-node1上で、`/etc/nginx/mime.types`の現在の内容を確認します。

**▼ 実行結果**

```plaintext
control@ubuntu-node1:~$ cat /etc/nginx/mime.types

types {
    text/html                             html htm shtml;
    text/css                              css;
    text/xml                              xml;
    image/gif                             gif;
    image/jpeg                            jpeg jpg;
    application/javascript                js;
    application/atom+xml                  atom;
    application/rss+xml                   rss;

    text/mathml                           mml;
    text/plain                            txt;
    text/vnd.sun.j2me.app-descriptor      jad;
    text/vnd.wap.wml                      wml;
    text/x-component                      htc;

    image/png                             png;
    image/tiff                            tif tiff;
    image/vnd.wap.wbmp                    wbmp;
    image/x-icon                          ico;
    image/x-jng                           jng;
    image/x-ms-bmp                        bmp;
    image/svg+xml                         svg svgz;
    image/webp                            webp;

    application/font-woff                 woff;
    application/java-archive              jar war ear;
    application/json                      json;
    application/mac-binhex40              hqx;
    application/msword                    doc;
    application/pdf                       pdf;
    application/postscript                ps eps ai;
    application/rtf                       rtf;
    application/vnd.apple.mpegurl         m3u8;
    application/vnd.ms-excel              xls;
    application/vnd.ms-fontobject         eot;
    application/vnd.ms-powerpoint         ppt;
    application/vnd.wap.wmlc              wmlc;
    application/vnd.google-earth.kml+xml  kml;
    application/vnd.google-earth.kmz      kmz;
    application/x-7z-compressed           7z;
    application/x-cocoa                   cco;
    application/x-java-archive-diff       jardiff;
    application/x-java-jnlp-file          jnlp;
    application/x-makeself                run;
    application/x-perl                    pl pm;
    application/x-pilot                   prc pdb;
    application/x-rar-compressed          rar;
    application/x-redhat-package-manager  rpm;
    application/x-sea                     sea;
    application/x-shockwave-flash         swf;
    application/x-stuffit                 sit;
    application/x-tcl                     tcl tk;
    application/x-x509-ca-cert            der pem crt;
    application/x-xpinstall               xpi;
    application/xhtml+xml                 xhtml;
    application/xspf+xml                  xspf;
    application/zip                       zip;

    application/octet-stream              bin exe dll;
    application/octet-stream              deb;
    application/octet-stream              dmg;
    application/octet-stream              iso img;
    application/octet-stream              msi msp msm;

    application/vnd.openxmlformats-officedocument.wordprocessingml.document    docx;
    application/vnd.openxmlformats-officedocument.spreadsheetml.sheet          xlsx;
    application/vnd.openxmlformats-officedocument.presentationml.presentation  pptx;

    audio/midi                            mid midi kar;
    audio/mpeg                            mp3;
    audio/ogg                             ogg;
    audio/x-m4a                           m4a;
    audio/x-realaudio                     ra;

    video/3gpp                            3gpp 3gp;
    video/mp2t                            ts;
    video/mp4                             mp4;
    video/mpeg                            mpeg mpg;
    video/quicktime                       mov;
    video/webm                            webm;
    video/x-flv                           flv;
    video/x-m4v                           m4v;
    video/x-mng                           mng;
    video/x-ms-asf                        asx asf;
    video/x-ms-wmv                        wmv;
    video/x-msvideo                       avi;
}
```

---

#### 2.【cronジョブによる自動書き換え】

ubuntu-node1上で、検証用のcronジョブを一時的に登録します。1分ごとに`/etc/nginx/mime.types`へ1行追記するジョブです。

**実行コマンド**

```plaintext
(sudo crontab -l 2>/dev/null; echo '* * * * * echo "# added by cron $(date)" >> /etc/nginx/mime.types') | sudo crontab -
```

登録内容の確認：

```plaintext
control@ubuntu-node1:~$ sudo crontab -l
* * * * * echo "# added by cron $(date)" >> /etc/nginx/mime.types
```

1〜2分待機し、`mime.types`に変更が加わったことを確認します。

**▼ 変更後のファイル内容**

```
control@ubuntu-node1:~$ cat /etc/nginx/mime.types

types {
    text/html                             html htm shtml;
    text/css                              css;
    text/xml                              xml;
    image/gif                             gif;
    image/jpeg                            jpeg jpg;
    application/javascript                js;
    application/atom+xml                  atom;
    application/rss+xml                   rss;

    text/mathml                           mml;
    text/plain                            txt;
    text/vnd.sun.j2me.app-descriptor      jad;
    text/vnd.wap.wml                      wml;
    text/x-component                      htc;

    image/png                             png;
    image/tiff                            tif tiff;
    image/vnd.wap.wbmp                    wbmp;
    image/x-icon                          ico;
    image/x-jng                           jng;
    image/x-ms-bmp                        bmp;
    image/svg+xml                         svg svgz;
    image/webp                            webp;

    application/font-woff                 woff;
    application/java-archive              jar war ear;
    application/json                      json;
    application/mac-binhex40              hqx;
    application/msword                    doc;
    application/pdf                       pdf;
    application/postscript                ps eps ai;
    application/rtf                       rtf;
    application/vnd.apple.mpegurl         m3u8;
    application/vnd.ms-excel              xls;
    application/vnd.ms-fontobject         eot;
    application/vnd.ms-powerpoint         ppt;
    application/vnd.wap.wmlc              wmlc;
    application/vnd.google-earth.kml+xml  kml;
    application/vnd.google-earth.kmz      kmz;
    application/x-7z-compressed           7z;
    application/x-cocoa                   cco;
    application/x-java-archive-diff       jardiff;
    application/x-java-jnlp-file          jnlp;
    application/x-makeself                run;
    application/x-perl                    pl pm;
    application/x-pilot                   prc pdb;
    application/x-rar-compressed          rar;
    application/x-redhat-package-manager  rpm;
    application/x-sea                     sea;
    application/x-shockwave-flash         swf;
    application/x-stuffit                 sit;
    application/x-tcl                     tcl tk;
    application/x-x509-ca-cert            der pem crt;
    application/x-xpinstall               xpi;
    application/xhtml+xml                 xhtml;
    application/xspf+xml                  xspf;
    application/zip                       zip;

    application/octet-stream              bin exe dll;
    application/octet-stream              deb;
    application/octet-stream              dmg;
    application/octet-stream              iso img;
    application/octet-stream              msi msp msm;

    application/vnd.openxmlformats-officedocument.wordprocessingml.document    docx;
    application/vnd.openxmlformats-officedocument.spreadsheetml.sheet          xlsx;
    application/vnd.openxmlformats-officedocument.presentationml.presentation  pptx;

    audio/midi                            mid midi kar;
    audio/mpeg                            mp3;
    audio/ogg                             ogg;
    audio/x-m4a                           m4a;
    audio/x-realaudio                     ra;

    video/3gpp                            3gpp 3gp;
    video/mp2t                            ts;
    video/mp4                             mp4;
    video/mpeg                            mpeg mpg;
    video/quicktime                       mov;
    video/webm                            webm;
    video/x-flv                           flv;
    video/x-m4v                           m4v;
    video/x-mng                           mng;
    video/x-ms-asf                        asx asf;
    video/x-ms-wmv                        wmv;
    video/x-msvideo                       avi;
}
# added by cron Fri Jul 17 01:21:01 AM UTC 2026
# added by cron Fri Jul 17 01:22:01 AM UTC 2026
```

**※上記の通りファイルの末尾に2行追加されたことを確認済み**

変更が確認できたので、後続の実行に影響しないよう、cronジョブを削除します。

```plaintext
sudo crontab -r
```

削除の確認：

```plaintext
control@ubuntu-node1:~$ sudo crontab -l
no crontab for root
```

---

#### 3.【2回目の実行】

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini playbooks/configure_nginx_worker_processes.yml
```

**▼ 実行結果**

```plaintext
PLAY [Configure nginx worker_processes (lineinfile)] ****************************************************************************************************************************************

TASK [worker_processesの値を管理する] *******************************************************************************************************************************************************
ok: [ubuntu-node2]
ok: [ubuntu-node1]
ok: [ubuntu-node3]

PLAY RECAP **********************************************************************************************************************************************************************************
ubuntu-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
ubuntu-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
ubuntu-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

【リモートノード側】

- ubuntu-node1（192.168.56.31）

**※2回目実行後のファイル内容：**

```plaintext
control@ubuntu-node1:~$ cat /etc/nginx/mime.types

types {
    text/html                             html htm shtml;
    text/css                              css;
    text/xml                              xml;
    image/gif                             gif;
    image/jpeg                            jpeg jpg;
    application/javascript                js;
    application/atom+xml                  atom;
    application/rss+xml                   rss;

    text/mathml                           mml;
    text/plain                            txt;
    text/vnd.sun.j2me.app-descriptor      jad;
    text/vnd.wap.wml                      wml;
    text/x-component                      htc;

    image/png                             png;
    image/tiff                            tif tiff;
    image/vnd.wap.wbmp                    wbmp;
    image/x-icon                          ico;
    image/x-jng                           jng;
    image/x-ms-bmp                        bmp;
    image/svg+xml                         svg svgz;
    image/webp                            webp;

    application/font-woff                 woff;
    application/java-archive              jar war ear;
    application/json                      json;
    application/mac-binhex40              hqx;
    application/msword                    doc;
    application/pdf                       pdf;
    application/postscript                ps eps ai;
    application/rtf                       rtf;
    application/vnd.apple.mpegurl         m3u8;
    application/vnd.ms-excel              xls;
    application/vnd.ms-fontobject         eot;
    application/vnd.ms-powerpoint         ppt;
    application/vnd.wap.wmlc              wmlc;
    application/vnd.google-earth.kml+xml  kml;
    application/vnd.google-earth.kmz      kmz;
    application/x-7z-compressed           7z;
    application/x-cocoa                   cco;
    application/x-java-archive-diff       jardiff;
    application/x-java-jnlp-file          jnlp;
    application/x-makeself                run;
    application/x-perl                    pl pm;
    application/x-pilot                   prc pdb;
    application/x-rar-compressed          rar;
    application/x-redhat-package-manager  rpm;
    application/x-sea                     sea;
    application/x-shockwave-flash         swf;
    application/x-stuffit                 sit;
    application/x-tcl                     tcl tk;
    application/x-x509-ca-cert            der pem crt;
    application/x-xpinstall               xpi;
    application/xhtml+xml                 xhtml;
    application/xspf+xml                  xspf;
    application/zip                       zip;

    application/octet-stream              bin exe dll;
    application/octet-stream              deb;
    application/octet-stream              dmg;
    application/octet-stream              iso img;
    application/octet-stream              msi msp msm;

    application/vnd.openxmlformats-officedocument.wordprocessingml.document    docx;
    application/vnd.openxmlformats-officedocument.spreadsheetml.sheet          xlsx;
    application/vnd.openxmlformats-officedocument.presentationml.presentation  pptx;

    audio/midi                            mid midi kar;
    audio/mpeg                            mp3;
    audio/ogg                             ogg;
    audio/x-m4a                           m4a;
    audio/x-realaudio                     ra;

    video/3gpp                            3gpp 3gp;
    video/mp2t                            ts;
    video/mp4                             mp4;
    video/mpeg                            mpeg mpg;
    video/quicktime                       mov;
    video/webm                            webm;
    video/x-flv                           flv;
    video/x-m4v                           m4v;
    video/x-mng                           mng;
    video/x-ms-asf                        asx asf;
    video/x-ms-wmv                        wmv;
    video/x-msvideo                       avi;
}
# added by cron Fri Jul 17 01:21:01 AM UTC 2026
# added by cron Fri Jul 17 01:22:01 AM UTC 2026
```

---

#### ■ 結果

1回目の実行では、全ノードで`changed=0`となり、`worker_processes`が管理対象であるにもかかわらず、`/etc/nginx/mime.types`には一切変更が加えられていないことを確認しました。

cronジョブによる自動書き換えでは、`mime.types`の末尾に`# added by cron`で始まる行が2行追加されました。この時点で、ubuntu-node1の`mime.types`はdesired stateと異なる状態になっています。

この状態で2回目の`ansible-playbook`を実行した結果、cronジョブによる変更を加えたubuntu-node1を含め、全ノードが`changed=0`のままでした。1回目の実行結果と同じであり、`--check`を使わない通常実行であっても、この変更は一切検知されませんでした。

2回目実行後のリモートノード側を確認すると、cronジョブが追記した2行はそのまま残っていました。Playbookが管理している`worker_processes`の行には手を加えていないため、そちらも変化していません。

この結果から、`configure_nginx_worker_processes.yml`のタスクに一切記述されていない`mime.types`というファイルは、通常実行であっても比較対象にすら含まれないことが分かります。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** セクション6では`--check`実行時に同様の結果を確認しましたが、今回の検証によって、`--check`に限らず通常実行でも同じ限界が働くことが実機で確認できました。

Playbookが`changed=0`で正常終了したことは、「Ansibleが管理している範囲に差分がなかった」ことを意味するのであり、「サーバ全体がdesired stateと一致している」ことを意味しません。今回のケースでは、`worker_processes`という管理対象は正しい状態を保っていましたが、`mime.types`というファイルは、cronジョブによって書き換えられた状態のまま、2回のPlaybook実行を通過しました。「Playbookが正常終了している＝サーバが正しい状態にある」という理解が成立しない場面があることが、この検証で確認できました。


---

[↑ 目次に戻る](#-目次)

---

## 6. まとめ

この回で整理した内容を確認します。

- 「changedが出ない」とは、Playbookの実行結果として`changed=1`が返らず`changed=0`のまま通過することを指す。ドリフトが実際に発生していても、実行結果にはそれが現れない
- changedが出ないドリフトは、Playbookのタスクに記述されていない要素に対して発生する。cronジョブなど完全に管理外のファイルの変化だけでなく、ファイルの一部だけを管理している場合の管理外項目(アプリケーションによる自己書き換え、セキュリティツールによる管理外属性の変更)、`state: present`のようにバージョンを比較対象に含まない指定も、同じ構造に当てはまる
- 冪等性シリーズ第9回セクション2が示した「2回実行して`changed=0`になること」という確認手法は、外部状態の安定・実行経路の単一性という2つの前提のもとで成立する。ドリフトの文脈ではこれに加えて「Ansible管理外の変化が発生していないこと」という前提が必要であり、changedが出ないドリフトはこの前提を崩す
- Ansible管理外のファイル(`/etc/nginx/mime.types`)をcronジョブで書き換えた状態を実機で作り、通常実行のPlaybookを実行したところ、全ノードで`changed=0`のまま通過し、手動変更は検知されなかった。第2回セクション6で確認した`--check`実行時と同じ限界が、通常実行でも同様に働くことを実機で確認した
- Playbookが`changed=0`で正常終了したことは、「Ansibleが管理している範囲に差分がなかった」ことを意味するのであり、「サーバ全体が正しい状態にある」ことを意味しない


---

[↑ 目次に戻る](#-目次)

---

## 7. 次回予告

次回は、「ドリフトを検知して修正する設計」を扱います。

changedが出ないドリフトを含めて、ドリフトを「防ぐ」「検知する」「修正する」という3つの設計パターンをどう運用に組み込むかを整理します。

次回：第4回：ドリフトを検知して修正する設計

---

📑 連載の移動　**[前の記事：【構成ドリフト編】 第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)　｜　次の記事：【構成ドリフト編】 第4回**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「Ansibleは冪等なのに、なぜサーバは壊れていくのか」シリーズまとめブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 8. 連載一覧:「Ansibleは冪等なのに、なぜサーバは壊れていくのか」

| 回                                                                                              | タイトル                          | 内容（概要）                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **[第0回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-00/)** | なぜAnsibleで管理しているのにサーバはずれていくのか | 構成ドリフトを「Playbookで定義したdesired stateと実際のサーバの状態がずれていく現象」として定義し、冪等性シリーズとの違いを整理する。ドリフトが「Ansibleが実行されていない時間」に起きる問題であることを理解する。 |
| **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)** | なぜ手動変更はAnsibleの管理を壊すのか        | 障害対応や一時的な直接編集がドリフトを生む構造を、`template`と`lineinfile`の挙動の違いを通して理解する。手動変更が「次にAnsibleが実行されるまで気づかれない」空白を作ることを整理する。              |
| **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** | なぜdriftは`--check`で検知できないのか    | `--check`/`--diff`モードをドリフト検知の手段として使う場合の限界を整理する。検知できるケースと検知できないケースを実機で切り分け、「`--check`で問題が出ない＝ドリフトがない」ではないことを理解する。        |
| 第3回                                                                                            | なぜドリフトは気づかれないまま進むのか           | `changed`が出ない「静かなドリフト」の構造を扱う。cronジョブやアプリケーションの自己書き換え、パッケージの自動更新など、Ansible管理外で起きる変化がPlaybook実行結果に現れない理由を理解する。            |
| 第4回                                                                                            | ドリフトを検知して修正する設計               | シリーズの結論として、ドリフトを「防ぐ」「検知する」「修正する」の3つの設計パターンを整理する。定期実行・アラート化・自動修正フローなど、運用に組み込むための具体的な設計を扱う。                               |


---

[↑ 目次に戻る](#-%E7%9B%AE%E6%AC%A1)

---



