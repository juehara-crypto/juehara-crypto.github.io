---
title: '「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第4回：なぜ「最新化」は冪等性を壊すのか'
description: 'yum/apt の state: latest やバージョン未固定が、再実行ごとに状態を変化させる理由を理解する。desired state と「現在の最新版」は別物であることを学ぶ。'
pubDate: '2026-07-27'
category: 'infra'
tags: ['Ansible', '冪等性', 'idempotency', 'shell', 'command']
seriesId: 'ansible-idempotency'
seriesNo: 4
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/'
nextPost: ''
relatedSeries: ''
---


> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 シリーズまとめブログ**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [state-presentとstate-latestは何が違うのか](#2-state-presentとstate-latestは何が違うのか)
3. [同じPlaybookが時間経過で別結果になる](#3-同じplaybookが時間経過で別結果になる)
4. [desired-stateが外部に委譲されている](#4-desired-stateが外部に委譲されている)
5. [バージョン未固定も同じ構造を持つ](#5-バージョン未固定も同じ構造を持つ)
6. [冪等性はPlaybook単体では閉じない](#6-冪等性はplaybook単体では閉じない)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜](#9-連載一覧ansibleは本当に冪等なのか冪等性が崩れる構造と設計)

---

## 1. はじめに

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)** では、`copy` や `template` モジュールを正しく使っていても、差分検出が意図どおりに動かないパターンを取り上げました。原因はいずれも「Ansibleが観測しているのはバイト列とメタデータであり、設定の意味ではない」という構造にありました。

今回はさらに別の問題に進みます。差分検出の仕組み自体は正しく動いているにもかかわらず、同じPlaybookを実行するたびに結果が変わるケースです。

原因は差分検出の側にはありません。比較の基準になるdesired stateそのものが、実行のたびに変化しています。`state: latest` のような指定がその典型です。この回では、desired stateが外部の状態に依存する場合に何が起きるのかを整理します。


---

[↑ 目次に戻る](#-目次)

---

## 2. state-presentとstate-latestは何が違うのか


`dnf` モジュールの `state` パラメータには複数の値が指定できますが、よく使われるのは `present` と `latest` の2つです。この2つは動作が異なります。

* `state: present` は「パッケージがインストールされている状態」をdesired stateとして定義します。**すでにインストール済みであれば、バージョンにかかわらず「インストール済みなので変更不要」と判断し、`changed=0` を返します。**

* `state: latest` は「リポジトリで提供されている最新バージョンがインストールされている状態」をdesired stateとして定義します。**インストール済みのバージョンとリポジトリの最新バージョンが一致していなければ `changed=1` になり、アップグレードが実行されます。**

この動作の違いを実際に確認します。`state: present` と `state: latest` それぞれで同じPlaybookを2回実行し、2回目の挙動を比較します。

---

### ■ 検証内容（state: present と state: latest の比較）

検証にはnginxを使います。事前にリモートノード側にnginxがインストールされていないことを確認しておきます。

**【事前確認】リモートノード側のnginx未インストール確認**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ rpm -q nginx
パッケージ nginx はインストールされていません。
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ rpm -q nginx
パッケージ nginx はインストールされていません。
```

---

#### ■ パターンA：state: present

**ファイル名: `test_state_present.yml`**

```yaml
---
- name: state present の動作確認
  hosts: test_servers
  gather_facts: false
  become: true

  tasks:
   - name: 'nginx をインストールする（state: present）'
     ansible.builtin.dnf:
        name: nginx
        state: present
```

#### ■ 1回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_state_present.yml
```

**▼ 1回目の実行結果**


```plaintext
PLAY [state present の動作確認] *************************************************************************************************************************************************************

TASK [nginx をインストールする（state: present）] *******************************************************************************************************************************************
changed: [192.168.1.21]
changed: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【1回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ rpm -q nginx
nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ rpm -q nginx
nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
```

---

#### ■ 2回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_state_present.yml
```

**▼ 2回目の実行結果**

```plaintext
PLAY [state present の動作確認] *************************************************************************************************************************************************************

TASK [nginx をインストールする（state: present）] *******************************************************************************************************************************************
ok: [192.168.1.22]
ok: [192.168.1.21]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ rpm -q nginx
nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ rpm -q nginx
nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
```

---

##### ■ パターンB：state: latest

**ファイル名: `test_state_latest.yml`**

```yaml
---
- name: state latest の動作確認
  hosts: test_servers
  gather_facts: false
  become: true

  tasks:
    - name: 'nginx をインストールする(state: latest)'
      ansible.builtin.dnf:
        name: nginx
        state: latest
```

#### ■ 1回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_state_latest.yml
```

**▼ 1回目の実行結果**

```plaintext
PLAY [state latest の動作確認] **************************************************************************************************************************************************************

TASK [nginx をインストールする(state: latest)] **********************************************************************************************************************************************
ok: [192.168.1.22]
ok: [192.168.1.21]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【1回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ rpm -q nginx
nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ rpm -q nginx
nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
```

---

#### ■ 2回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_state_latest.yml
```

**▼ 2回目の実行結果**

```plaintext
PLAY [state latest の動作確認] **************************************************************************************************************************************************************

TASK [nginx をインストールする(state: latest)] **********************************************************************************************************************************************
ok: [192.168.1.22]
ok: [192.168.1.21]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ rpm -q nginx
nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ rpm -q nginx
nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
```


---

### ■ 結果

パターンAでは、1回目の実行で両ノードに `nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64` がインストールされ `changed=1` となりました。2回目の実行ではすでにインストール済みであるため、`state: present` は「インストール済みなので変更不要」と判断し `changed=0` を返しました。バージョンの確認は行っていません。

パターンBはパターンAの直後、nginxがインストール済みの状態から開始しています。`state: latest` は実行時点でリポジトリの最新バージョンと照合しますが、インストール済みの `nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64` がすでに最新版であったため、1回目・2回目ともに `changed=0` となりました。

2つのパターンで `changed=0` という結果は同じに見えます。しかし内部で行っている判断は異なります。`state: present` はインストールの有無だけを確認しています。`state: latest` はリポジトリの現在の最新バージョンと照合しています。この照合対象がPlaybook外の外部状態であることが、次のセクションで取り上げる問題につながります。


---

[↑ 目次に戻る](#-目次)

---

## 3. 同じPlaybookが時間経過で別結果になる

このセクションでは、`state: latest` を使ったPlaybookが時間経過によって別の結果を返す構造を説明します。

セクション2の検証では、パターンBの実行時点でインストール済みのnginxがリポジトリの最新版と一致していたため、1回目・2回目ともに `changed=0` になりました。しかしリポジトリ側でnginxが更新された場合、同じPlaybookを実行しても結果が変わります。

検証環境ではリポジトリの更新を待つことはできないため、以下の方法で再現します。nginxをバージョン指定でダウングレードした状態を作り、その状態で `state: latest` を実行します。インストール済みのバージョンがリポジトリの最新版より古い状態になるので、「リポジトリが更新されて現在のバージョンが古くなった」状況と同じ構造になります。

---

### ■ 検証内容（ダウングレード後に state: latest を実行）

事前にリモートノード側で利用可能なnginxのバージョン一覧を確認します。

**【事前確認】利用可能なnginxのバージョン一覧**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ sudo dnf list --showduplicates nginx
メタデータの期限切れの最終確認: 0:08:47 前の 2026年06月17日 17時09分14秒 に実施しました。
インストール済みパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     @appstream
利用可能なパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9.rocky.0.1                                                                         appstream
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     appstream
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo dnf list --showduplicates nginx
メタデータの期限切れの最終確認: 0:32:45 前の 2026年06月17日 16時45分52秒 に実施しました。
インストール済みパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     @appstream
利用可能なパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9.rocky.0.1                                                                         appstream
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     appstream
```

両ノードとも現在のインストール済みバージョンは `2:1.20.1-28.el9_8.2.rocky.0.1` で、旧バージョン `2:1.20.1-28.el9.rocky.0.1` が利用可能な状態です。以下のPlaybookで旧バージョンにダウングレードします。

**ファイル名: `test_downgrade.yml`**

```yaml
---
- name: nginx をダウングレードする
  hosts: test_servers
  gather_facts: false
  become: true

  tasks:
    - name: 'nginx を旧バージョンに戻す'
      ansible.builtin.dnf:
        name: nginx-1.20.1-28.el9.rocky.0.1.x86_64
        state: present
        allow_downgrade: true
```


**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_downgrade.yml
```


**▼ ダウングレードの実行結果**

```plaintext
PLAY [nginx をダウングレードする] ***********************************************************************************************************************************************************

TASK [nginx を旧バージョンに戻す] ***********************************************************************************************************************************************************
changed: [192.168.1.22]
changed: [192.168.1.21]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【ダウングレード後のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ sudo dnf list --showduplicates nginx
メタデータの期限切れの最終確認: 0:24:19 前の 2026年06月17日 17時09分14秒 に実施しました。
インストール済みパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9.rocky.0.1                                                                         @appstream
利用可能なパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9.rocky.0.1                                                                         appstream
nginx.x86_64
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo dnf list --showduplicates nginx
[sudo] ansibleuser2 のパスワード:
メタデータの期限切れの最終確認: 0:13:04 前の 2026年06月17日 17時21分16秒 に実施しました。
インストール済みパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9.rocky.0.1                                                                         @appstream
利用可能なパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9.rocky.0.1                                                                         appstream
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     appstream
[ansibleuser2@localhost ~]$
```

**※(補足) 上記の通り、両ノードともに最新版の「2:1.20.1-28.el9_8.2.rocky.0.1」から、旧バージョンの「2:1.20.1-28.el9.rocky.0.1」にダウングレードされたことを確認済み**


ダウングレードが確認できたら、続けて `test_state_latest.yml` を実行します。


**ファイル名: `test_state_latest.yml`**

```yaml
---
- name: state latest の動作確認
  hosts: test_servers
  gather_facts: false
  become: true

  tasks:
    - name: 'nginx をインストールする(state: latest)'
      ansible.builtin.dnf:
        name: nginx
        state: latest
```


##### ■ 1回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_state_latest.yml
```

**▼ 1回目の実行結果**

```plaintext
PLAY [state latest の動作確認] **************************************************************************************************************************************************************

TASK [nginx をインストールする(state: latest)] **********************************************************************************************************************************************
changed: [192.168.1.22]
changed: [192.168.1.21]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【1回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ sudo dnf list --showduplicates nginx
メタデータの期限切れの最終確認: 0:31:47 前の 2026年06月17日 17時09分14秒 に実施しました。
インストール済みパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     @appstream
利用可能なパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9.rocky.0.1                                                                         appstream
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     appstream
[ansibleuser@localhost ~]$
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo dnf list --showduplicates nginx
[sudo] ansibleuser2 のパスワード:
メタデータの期限切れの最終確認: 0:20:15 前の 2026年06月17日 17時21分16秒 に実施しました。
インストール済みパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     @appstream
利用可能なパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9.rocky.0.1                                                                         appstream
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     appstream
[ansibleuser2@localhost ~]$
```

**※(補足) 上記の通り、両ノードともに旧バージョンの「2:1.20.1-28.el9.rocky.0.1」から、最新版の「2:1.20.1-28.el9_8.2.rocky.0.1」にアップグレードされていることを確認済み**


---

##### ■ 2回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_state_latest.yml
```

**▼ 2回目の実行結果**

```plaintext
PLAY [state latest の動作確認] **************************************************************************************************************************************************************

TASK [nginx をインストールする(state: latest)] **********************************************************************************************************************************************
ok: [192.168.1.22]
ok: [192.168.1.21]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）
```plaintext
[ansibleuser@localhost ~]$ sudo dnf list --showduplicates nginx
メタデータの期限切れの最終確認: 0:36:08 前の 2026年06月17日 17時09分14秒 に実施しました。
インストール済みパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     @appstream
利用可能なパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9.rocky.0.1                                                                         appstream
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     appstream
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ sudo dnf list --showduplicates nginx
メタデータの期限切れの最終確認: 0:25:00 前の 2026年06月17日 17時21分16秒 に実施しました。
インストール済みパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     @appstream
利用可能なパッケージ
nginx.x86_64                                                                     2:1.20.1-28.el9.rocky.0.1                                                                         appstream
nginx.x86_64                                                                     2:1.20.1-28.el9_8.2.rocky.0.1                                                                     appstream
[ansibleuser2@localhost ~]$
```

**(補足) インストール済みのパッケージがリポジトリの最新版と一致している為、変更無し「changed=0」となっています。**

---

#### ■ 結果

`test_downgrade.yml` の実行で両ノードのnginxを `2:1.20.1-28.el9_8.2.rocky.0.1` から `2:1.20.1-28.el9.rocky.0.1` にダウングレードしました。これはリポジトリ側に新しいバージョンが追加され、インストール済みのバージョンが古くなった状況と同じ構造です。

この状態で `test_state_latest.yml` を実行すると、1回目は両ノードで `changed=1` となり、`2:1.20.1-28.el9_8.2.rocky.0.1` へのアップグレードが実行されました。`state: latest` がリポジトリの最新バージョンと照合した結果、インストール済みのバージョンとの差分を検出したためです。

2回目の実行では両ノードで `changed=0` となりました。1回目の実行でインストール済みのバージョンがリポジトリの最新版と一致した状態になっているためです。

ここで確認できるのは、Playbookの内容は1回目と2回目で何も変わっていないという点です。`state: latest` が参照するdesired stateはリポジトリの現在の最新バージョンであり、Playbookの外にあります。今回はダウングレードによってその差分を意図的に作りましたが、実際の運用ではリポジトリ側の更新によって同じことが起きます。同じPlaybookを実行しても、リポジトリの状態が変わっていれば `changed=0` だった結果が `changed=1` に変わります。


---

[↑ 目次に戻る](#-目次)

---

## 4. desired stateが外部に委譲されている

このセクションでは、`state: latest` が抱える構造上の問題を整理します。

セクション3の検証で確認したとおり、`state: latest` はリポジトリの現在の最新バージョンをdesired stateとして参照します。この「リポジトリの現在の最新バージョン」はPlaybookの外にあります。

`state: present` と `state: latest` のdesired stateの所在を比較すると、以下のようになります。

| 指定               | desired stateの定義      | desired stateの所在 |
| ---------------- | --------------------- | ---------------- |
| `state: present` | パッケージが存在していること        | Playbook内で閉じている  |
| `state: latest`  | リポジトリの現在の最新バージョンであること | リポジトリ（外部）に依存している |

* **`state: present` の場合：**「パッケージが存在していること」というdesired stateはPlaybookに書かれた時点で固定されています。リポジトリ側に変化があっても、このdesired stateは変わりません。

* **`state: latest` の場合：**「最新バージョン」の定義はリポジトリの状態によって変わります。今日の最新版と明日の最新版は別のバージョンである可能性があります。Playbookの記述は変わっていないにもかかわらず、desired stateが実行のたびに変化します。これがセクション3で確認した「同じPlaybookが別結果になる」という現象の原因です。

つまり `state: latest` は、desired stateの定義をリポジトリ側に委譲しています。Ansibleがコントロールできる範囲の外にdesired stateが置かれている状態です。

なお、`state: latest` が実務上不要というわけではありません。セキュリティパッチの自動適用や、常に最新版を維持したい運用ポリシーでは有効な指定です。重要なのは「冪等性とのトレードオフがある」という構造を理解した上で使うことです。


---

[↑ 目次に戻る](#-目次)

---

## 5. バージョン未固定も同じ構造を持つ

このセクションでは、`state: latest` 以外にも同じ問題を持つケースとして、バージョン未固定の指定を取り上げます。

以下の2つのPlaybookを比較します。

**バージョン未固定の指定**

```yaml
- name: 'nginx をインストールする（バージョン未固定）'
  ansible.builtin.dnf:
    name: nginx
    state: present
```

**バージョン固定の指定**

```yaml
- name: 'nginx をインストールする（バージョン固定）'
  ansible.builtin.dnf:
    name: nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64
    state: present
```

バージョン固定の場合、desired stateは「`nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64` がインストールされていること」です。この定義はPlaybookに書かれた時点で固定されており、環境やリポジトリの状態に関係なく同じです。

バージョン未固定の場合、desired stateは「nginxがインストールされていること」ですが、「どのバージョンのnginxか」はインストール時点のリポジトリの状態に依存します。Rocky Linux 9とUbuntu 22.04では提供されているnginxのバージョンが異なります。同じ `name: nginx` という指定でも、環境によって導入される実体が変わります。

`state: latest` との違いは、バージョン未固定の場合は `state: present` を使っていても同じ問題が起きるという点です。`state` の値ではなく、`name` にバージョンを含めるかどうかがdesired stateの安定性に影響します。

|指定方法|desired stateの安定性|
|---|---|
|`name: nginx-1.20.1-28.el9_8.2.rocky.0.1.x86_64`|Playbook内で固定されている|
|`name: nginx`（バージョン未固定）|環境・リポジトリの状態に依存する|

ただし、バージョンを固定することにもトレードオフがあります。固定したバージョンがリポジトリから削除された場合、Playbookが動作しなくなります。セキュリティパッチへの追従も手動での更新が必要になります。バージョンを固定するかどうかは、再現性と追従性のどちらを優先するかという運用上の判断です。


---

[↑ 目次に戻る](#-目次)

---

## 6. 冪等性はPlaybook単体では閉じない

このセクションでは、セクション2〜5で見てきた内容を踏まえて、冪等性の成立条件を整理します。

第1回から第3回まで扱ってきた冪等性の問題は、いずれもPlaybook内で完結していました。shellモジュールの設計、差分検出の仕組み、テンプレートのレンダリング結果、これらはPlaybookの書き方によってコントロールできる範囲の話です。

第4回で扱った問題はその外側にあります。`state: latest` やバージョン未固定の指定では、desired stateの定義が以下のような外部要素に依存しています。

- upstreamでのパッケージ更新
- ミラーサーバーの同期状況
- パッケージメタデータの内容
- 実行時点のリポジトリの状態

これらはAnsibleがコントロールできる範囲の外にあります。Playbookの記述が同じでも、これらの外部要素が変化すれば実行結果が変わります。冪等性はPlaybook単体では閉じておらず、外部環境の状態も含めて初めて成立します。

冪等性が成立するための条件を整理すると以下のようになります。

|条件|内容|
|---|---|
|desired stateが固定されている|バージョンや状態の定義がPlaybook内で完結している|
|比較対象が安定している|外部リポジトリや環境差に依存していない|
|外部変動の影響を受けない|実行タイミングによって結果が変わらない|

`state: latest` やバージョン未固定の指定は、この条件を意図的に緩めた設計です。冪等性よりも最新版への追従を優先する判断として成立しますが、その場合は「このPlaybookは冪等ではない」という認識を持った上で運用する必要があります。


---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

- **`state: present` はPlaybook内でdesired stateが閉じている**。インストールの有無だけを確認するため、リポジトリの状態に関係なく結果が安定する。
- **`state: latest` はdesired stateが外部に委譲されている**。リポジトリの現在の最新バージョンを参照するため、リポジトリが更新されると同じPlaybookでも結果が変わる。
- **バージョン未固定の指定も同じ構造を持つ**。`name: nginx` のようにバージョンを指定しない場合、導入される実体が環境やリポジトリの状態に依存する。
- **冪等性はPlaybook単体では閉じない**。upstream・ミラーサーバー・パッケージメタデータなど、Ansibleがコントロールできない外部要素が変化すれば実行結果が変わる。
- **`state: latest` が悪ではなく、トレードオフがある**。セキュリティパッチの自動適用や最新版への追従が必要な運用では有効な指定だが、冪等性は成立しないという認識を持った上で使う必要がある。


---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

今回は、desired state自体が固定されていない場合に冪等性が成立しなくなる構造を見ました。`state: latest` やバージョン未固定の指定では、Playbook外の外部要素にdesired stateが依存するため、同じPlaybookを実行しても時間経過によって結果が変わります。

次回はさらに別の問題に進みます。desired stateは固定されているにもかかわらず、`changed=1` が連鎖的に別の状態遷移を引き起こすケースです。

**次回：第5回：なぜchangedはサービスを再起動させるのか ※近日公開予定**

Ansibleには `notify` と `handler` という仕組みがあります。タスクが `changed=1` を返したとき、その変更検知をトリガーとしてサービスの再起動やリロードが実行されます。この仕組みは意図どおりに動く場合は便利ですが、意図しない `changed=1` が発生したときに予期しない状態遷移を引き起こします。第4回が「desired stateの不安定さ」なら、第5回は「changedが副作用を連鎖させる構造」を扱います。

---

📑 連載の移動　**[前の記事：第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)　｜　次の記事：第5回**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 シリーズまとめブログ** **※近日公開予定**


---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 


| 回    | タイトル                            | 内容（概要）                                                                                               |
| ---- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **[第0回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-00/)**  | なぜAnsibleは「何度実行しても安全」だと思われているのか | 冪等性（idempotency）の本来の意味を整理し、「同じコマンドを繰り返せる」ことと「状態が収束する」ことの違いを理解する。                                     |
| **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)**  | shellモジュールはなぜ“状態”を扱えないのか        | shell/command が desired state を持てない理由を構造から整理する。changed_when は表示制御であり、冪等性保証ではないことを理解する。               |
| **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-02/)**  | なぜAnsible moduleは「変更不要」を判断できるのか | file/copy/template などの module が、現在状態と desired state の差分比較によって動作していることを理解する。Ansibleが宣言的管理に見える理由を整理する。 |
| **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)**  | なぜファイル操作は簡単に非冪等になるのか            | 改行コード、owner/group、Jinja2レンダリング差分など、「見えない差分」が changed を発生させる構造を理解する。                          |
| **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/)**  | なぜ“最新化”は冪等性を壊すのか                | yum/apt の state: latest やバージョン未固定が、再実行ごとに状態を変化させる理由を理解する。desired state と「現在の最新版」は別物であることを学ぶ。         |
| 第5回  | なぜサービス制御は再起動ループを生むのか            | service/systemd/handler の notify 連鎖を通して、「変更検知」がどのように状態遷移を引き起こすのかを理解する。reload/restart の違いも整理する。       |
| 第6回  | なぜlineinfileは“安全そうに見えて危険”なのか    | lineinfile は「状態管理」ではなく「部分パッチ」である。正規表現・重複挿入・文脈依存編集によって冪等性が崩れる構造を理解する。                                 |
| 第7回  | なぜ同じPlaybookなのに環境ごとに結果が変わるのか    | OS・ディストリビューション・systemd・Python・locale 差分によって、module の内部動作が変化することを理解する。                                |
| 第8回  | なぜタスクの依存関係は冪等性を壊すのか             | handler、register、条件分岐、タスク順序によって「前回実行結果」に依存したPlaybookが生まれる。状態遷移が閉じなくなる理由を整理する。                        |
| 第9回  | 冪等性はどうやって検証すべきなのか               | check mode の限界、diff mode、molecule、CI、自動テストを通して、「2回目 changed=0」をどう保証するのかを理解する。                        |
| 第10回 | 「冪等に設計する」とは何を設計することなのか          | imperative（手続き）ではなく declarative（状態宣言）としてPlaybookを設計する考え方を整理し、「壊れない構成管理」の原則を完成させる。                    |

---

[↑ 目次に戻る](#-目次)

---