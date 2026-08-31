---
title: '「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第2回：なぜAnsible moduleは「変更不要」を判断できるのか'
description: 'file/copy/template などの module が、現在状態と desired state の差分比較によって動作していることを理解する。Ansibleが宣言的管理に見える理由を整理する。'
pubDate: '2026-07-27'
category: 'infra'
tags: ['Ansible', '冪等性', 'idempotency', 'file', 'copy', 'template', 'desired state']
seriesId: 'ansible-idempotency'
seriesNo: 2
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/'
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
2. [fileモジュールは何を比較しているのか](#2-fileモジュールは何を比較しているのか)
3. [copyモジュールはどうやって差分を検出するのか](#3-copyモジュールはどうやって差分を検出するのか)
4. [templateモジュールの差分検出はどういう順序で行われるのか](#4-templateモジュールの差分検出はどういう順序で行われるのか)
5. [changedは「差分検出結果」である](#5-changedは差分検出結果である)
6. [「変更しない能力」はなぜ重要なのか](#6-変更しない能力はなぜ重要なのか)
7. [差分検出には限界がある](#7-差分検出には限界がある)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜](#10-連載一覧ansibleは本当に冪等なのか冪等性が崩れる構造と設計 ) 


---

## 1. はじめに

**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** では、shellモジュールが構造的に冪等判定できない理由を説明しました。shellモジュールはコマンドを実行するだけで、現在の状態を観測する仕組みを持っていません。そのため「実行したこと」自体を `changed` として報告します。

今回はその対比として、`file` / `copy` / `template` モジュールが「変更不要」をどのように判断しているのかを見ていきます。

これらのモジュールが `changed=0` を返せるのは、実行前に現在の状態を観測し、指定された状態と比較しているからです。この回では、その比較が具体的に何を対象にしているのかを整理します。


---

[↑ 目次に戻る](#-目次)

---

## 2. fileモジュールは何を比較しているのか

`file` モジュールがディレクトリ作成タスクで `changed=0` を返す場合、内部では以下の項目を比較しています。

|比較対象|内容|
|---|---|
|存在有無|指定パスが存在するかどうか|
|種別|file / directory / link のいずれか|
|owner|所有ユーザー|
|group|所有グループ|
|mode|パーミッション（例：0755）|


```yaml
- name: ディレクトリを作成する
  ansible.builtin.file:
    path: /tmp/sample
    state: directory
    owner: ansibleuser
    group: ansibleuser
    mode: '0755'
```

このタスクを2回実行した場合、2回目は上記の全項目が一致していれば `changed=0` になります。一項目でも差分があれば `changed=1` になり、その項目だけを修正します。

つまり `file` モジュールの `ok` は「全比較項目で差分がなかった」という判定の結果です。

この動作を実際に確認します。`owner・group・mode`を明示的に指定した上で、同じPlaybookを2回実行したときの挙動を見ます。

### ■ 検証内容（fileモジュールの差分検出）

【コントローラーノード側】

**ファイル名: `test_file_compare.yml`**


```yaml
---
- name: fileモジュールの差分検出確認
  hosts: test_servers
  gather_facts: false

  tasks:
    - name: ディレクトリを作成する（file）- ノード1
      ansible.builtin.file:
        path: /tmp/sample_file2
        state: directory
        owner: ansibleuser
        group: ansibleuser
        mode: '0755'
      when: inventory_hostname == '192.168.1.21'

    - name: ディレクトリを作成する（file）- ノード2
      ansible.builtin.file:
        path: /tmp/sample_file2
        state: directory
        owner: ansibleuser2
        group: ansibleuser2
        mode: '0755'
      when: inventory_hostname == '192.168.1.22'
```

---

#### ■ 1回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_file_compare.yml
```

**▼ 1回目の実行結果**


```plaintext
PLAY [fileモジュールの差分検出確認] *********************************************************************************************************************************************************

TASK [ディレクトリを作成する（file）- ノード1] **********************************************************************************************************************************************
skipping: [192.168.1.22]
changed: [192.168.1.21]

TASK [ディレクトリを作成する（file）- ノード2] **********************************************************************************************************************************************
skipping: [192.168.1.21]
changed: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

**【1回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$  ls -ld /tmp/sample_file2
drwxr-xr-x. 2 ansibleuser ansibleuser 6  6月 16 17:57 /tmp/sample_file2
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ ls -ld /tmp/sample_file2
drwxr-xr-x. 2 ansibleuser2 ansibleuser2 6  6月 16 17:57 /tmp/sample_file2
```

---

#### ■ 2回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_file_compare.yml
```

**▼ 2回目の実行結果**

```plaintext
PLAY [fileモジュールの差分検出確認] *********************************************************************************************************************************************************

TASK [ディレクトリを作成する（file）- ノード1] **********************************************************************************************************************************************
skipping: [192.168.1.22]
ok: [192.168.1.21]

TASK [ディレクトリを作成する（file）- ノード2] **********************************************************************************************************************************************
skipping: [192.168.1.21]
ok: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$  ls -ld /tmp/sample_file2
drwxr-xr-x. 2 ansibleuser ansibleuser 6  6月 16 17:57 /tmp/sample_file2
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ ls -ld /tmp/sample_file2
drwxr-xr-x. 2 ansibleuser2 ansibleuser2 6  6月 16 17:57 /tmp/sample_file2
```

---

### ■ 結果

1回目は両ノードで `changed=1` となり、ディレクトリが作成されました。2回目は両ノードで `changed=0` となり、タスクは `ok` として報告されました。

`when` 条件によって、各ノードは自分宛てでないタスクを `skipping` しています。これはPlaybookの構造上の動作であり、差分検出の結果には影響しません。PLAY RECAPの `skipped=1` はその反映です。

リモートノード側でディレクトリの状態を確認すると、2回目実行後もタイムスタンプ・owner・group・modeに変化はありませんでした。`file` モジュールは2回目の実行時に存在有無・種別・owner・group・modeの全項目を確認し、差分がないと判断しています。そのため何も操作せず、`changed=0` を返しています。


---

[↑ 目次に戻る](#-目次)

---

## 3. copyモジュールはどうやって差分を検出するのか

`copy` モジュールはファイルの内容比較にchecksumを使います。


```yaml
- name: 設定ファイルを配置する
  ansible.builtin.copy:
    src: files/nginx.conf
    dest: /etc/nginx/nginx.conf
    owner: root
    group: root
    mode: '0644'
```

`copy` モジュールが行う比較は以下の順序です。

1. 転送元ファイルのchecksumを計算する
2. 転送先ファイルのchecksumを取得する
3. checksumが一致すれば内容の差分なしと判断する
4. owner / group / mode を比較する
5. 全項目で差分がなければ `changed=0` を返す

ここで重要なのは、`copy` モジュールが「ファイルの内容を直接読み比べている」のではなく「checksumの一致を確認している」という点です。内容が同じであればchecksumも同じになるため、転送は行われません。

この動作を実際に確認します。コントローラーノード側に配置ファイルを用意した上で、同じPlaybookを2回実行したときの挙動を見ます。

---

### ■ 検証内容（copyモジュールの差分検出）

**【コントローラーノード側】**

事前に転送元ファイルを作成しておきます。

```plaintext
mkdir -p files
echo "server_name localhost;" > files/nginx.conf
```

**ファイル名: `test_copy_compare.yml`**

```yaml
---
- name: copyモジュールの差分検出確認
  hosts: test_servers
  gather_facts: false
  become: true

  tasks:
    - name: 設定ファイルを配置する（copy）- ノード1
      ansible.builtin.copy:
        src: files/nginx.conf
        dest: /tmp/nginx_copy.conf
        owner: ansibleuser
        group: ansibleuser
        mode: '0644'
      when: inventory_hostname == '192.168.1.21'

    - name: 設定ファイルを配置する（copy）- ノード2
      ansible.builtin.copy:
        src: files/nginx.conf
        dest: /tmp/nginx_copy.conf
        owner: ansibleuser2
        group: ansibleuser2
        mode: '0644'
      when: inventory_hostname == '192.168.1.22'
```

※ `dest` は `/etc/nginx/nginx.conf` ではなく `/tmp/nginx_copy.conf` としています。nginxの実設定を変更せず検証できるようにするためです。

---

#### ■ 1回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_copy_compare.yml
```

**▼ 1回目の実行結果**

```plaintext
PLAY [copyモジュールの差分検出確認] *********************************************************************************************************************************************************

TASK [設定ファイルを配置する（copy）- ノード1] **********************************************************************************************************************************************
skipping: [192.168.1.22]
changed: [192.168.1.21]

TASK [設定ファイルを配置する（copy）- ノード2] **********************************************************************************************************************************************
skipping: [192.168.1.21]
changed: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

**【1回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）
```plaintext
[ansibleuser@localhost ~]$ ls -l /tmp/nginx_copy.conf && cat /tmp/nginx_copy.conf
-rw-r--r--. 1 ansibleuser ansibleuser 23  6月 16 18:14 /tmp/nginx_copy.conf
server_name localhost;
```

- リモートノード2（192.168.1.22）
```plaintext
[ansibleuser2@localhost ~]$ ls -l /tmp/nginx_copy.conf && cat /tmp/nginx_copy.conf
-rw-r--r--. 1 ansibleuser2 ansibleuser2 23  6月 16 18:14 /tmp/nginx_copy.conf
server_name localhost;
```

---

#### ■ 2回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_copy_compare.yml
```

**▼ 2回目の実行結果**

```plaintext
PLAY [copyモジュールの差分検出確認] *********************************************************************************************************************************************************

TASK [設定ファイルを配置する（copy）- ノード1] **********************************************************************************************************************************************
skipping: [192.168.1.22]
ok: [192.168.1.21]

TASK [設定ファイルを配置する（copy）- ノード2] **********************************************************************************************************************************************
skipping: [192.168.1.21]
ok: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）
```plaintext
[ansibleuser@localhost ~]$ ls -l /tmp/nginx_copy.conf && cat /tmp/nginx_copy.conf
-rw-r--r--. 1 ansibleuser ansibleuser 23  6月 16 18:14 /tmp/nginx_copy.conf
server_name localhost;
```

- リモートノード2（192.168.1.22）
```plaintext
[ansibleuser2@localhost ~]$ ls -l /tmp/nginx_copy.conf && cat /tmp/nginx_copy.conf
-rw-r--r--. 1 ansibleuser2 ansibleuser2 23  6月 16 18:14 /tmp/nginx_copy.conf
server_name localhost;
```

---

### ■ 結果

1回目は両ノードで `changed=1` となり、ファイルが転送されました。2回目は両ノードで `changed=0` となり、タスクは `ok` として報告されました。

`when` 条件によって、各ノードは自分宛てでないタスクを `skipping` しています。PLAY RECAPの `skipped=1` はその反映であり、差分検出の結果には影響しません。

リモートノード側でファイルの状態を確認すると、2回目実行後もタイムスタンプ・内容・owner・group・modeに変化はありませんでした。`copy` モジュールは2回目の実行時に転送元ファイルのchecksumと転送先ファイルのchecksumを比較し、一致していることを確認しています。内容に差分がないため転送は行われず、`changed=0` を返しています。



---

[↑ 目次に戻る](#-目次)

---

## 4. templateモジュールの差分検出はどういう順序で行われるのか

`template` モジュールは `copy` と異なり、転送前にレンダリングが入ります。


```yaml
- name: 設定ファイルをテンプレートから配置する
  ansible.builtin.template:
    src: templates/nginx.conf.j2
    dest: /etc/nginx/nginx.conf
    owner: root
    group: root
    mode: '0644'
```

処理の順序は以下のとおりです。

1. `.j2` ファイルをJinja2でレンダリングし、出力内容を生成する
2. 生成した出力のchecksumを計算する
3. 転送先ファイルのchecksumを取得する
4. checksumが一致すれば内容の差分なしと判断する
5. owner / group / mode を比較する
6. 全項目で差分がなければ `changed=0` を返す

`copy` との違いは、比較対象が「転送元ファイルそのもの」ではなく「レンダリング後の出力」である点です。変数の値が変わらない限り、レンダリング結果も変わらないため、2回目以降は `changed=0` になります。

この動作を実際に確認します。変数を含むテンプレートファイルを用意した上で、同じPlaybookを2回実行したときの挙動を見ます。

---

### ■ 検証内容（templateモジュールの差分検出）

**【コントローラーノード側】**

事前にテンプレートファイルを作成しておきます。

```plaintext
mkdir -p templates
cat > templates/nginx.conf.j2 << 'EOF'
server_name {{ server_name }};
EOF
```

**ファイル名: `test_template_compare.yml`**

```yaml
---
- name: templateモジュールの差分検出確認
  hosts: test_servers
  gather_facts: false
  become: true

  vars:
    server_name: localhost

  tasks:
    - name: 設定ファイルをテンプレートから配置する（template）- ノード1
      ansible.builtin.template:
        src: templates/nginx.conf.j2
        dest: /tmp/nginx_template.conf
        owner: ansibleuser
        group: ansibleuser
        mode: '0644'
      when: inventory_hostname == '192.168.1.21'

    - name: 設定ファイルをテンプレートから配置する（template）- ノード2
      ansible.builtin.template:
        src: templates/nginx.conf.j2
        dest: /tmp/nginx_template.conf
        owner: ansibleuser2
        group: ansibleuser2
        mode: '0644'
      when: inventory_hostname == '192.168.1.22'
```

※ `dest` は `/tmp/nginx_template.conf` としています。nginxの実設定を変更せず検証できるようにするためです。

---

#### ■ 1回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_template_compare.yml
```

**▼ 1回目の実行結果**

```plaintext
PLAY [templateモジュールの差分検出確認] *****************************************************************************************************************************************************

TASK [設定ファイルをテンプレートから配置する（template）- ノード1] **************************************************************************************************************************
skipping: [192.168.1.22]
changed: [192.168.1.21]

TASK [設定ファイルをテンプレートから配置する（template）- ノード2] **************************************************************************************************************************
skipping: [192.168.1.21]
changed: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

**【1回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ ls -l /tmp/nginx_template.conf && cat /tmp/nginx_template.conf
-rw-r--r--. 1 ansibleuser ansibleuser 23  6月 16 18:30 /tmp/nginx_template.conf
server_name localhost;
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ ls -l /tmp/nginx_template.conf && cat /tmp/nginx_template.conf
-rw-r--r--. 1 ansibleuser2 ansibleuser2 23  6月 16 18:30 /tmp/nginx_template.conf
server_name localhost;
```

---

#### ■ 2回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_template_compare.yml
```

**▼ 2回目の実行結果**

```plaintext
PLAY [templateモジュールの差分検出確認] *****************************************************************************************************************************************************

TASK [設定ファイルをテンプレートから配置する（template）- ノード1] **************************************************************************************************************************
skipping: [192.168.1.22]
ok: [192.168.1.21]

TASK [設定ファイルをテンプレートから配置する（template）- ノード2] **************************************************************************************************************************
skipping: [192.168.1.21]
ok: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）
```plaintext
[ansibleuser@localhost ~]$ ls -l /tmp/nginx_template.conf && cat /tmp/nginx_template.conf
-rw-r--r--. 1 ansibleuser ansibleuser 23  6月 16 18:30 /tmp/nginx_template.conf
server_name localhost;
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ ls -l /tmp/nginx_template.conf && cat /tmp/nginx_template.conf
-rw-r--r--. 1 ansibleuser2 ansibleuser2 23  6月 16 18:30 /tmp/nginx_template.conf
server_name localhost;
```

---

### ■ 結果
1回目は両ノードで `changed=1` となり、レンダリング後のファイルが転送されました。2回目は両ノードで `changed=0` となり、タスクは `ok` として報告されました。

`when` 条件によって、各ノードは自分宛てでないタスクを `skipping` しています。PLAY RECAPの `skipped=1` はその反映であり、差分検出の結果には影響しません。

リモートノード側でファイルの状態を確認すると、2回目実行後もタイムスタンプ・内容・owner・group・modeに変化はありませんでした。`template` モジュールは2回目の実行時にJinja2でレンダリングした出力のchecksumと転送先ファイルのchecksumを比較し、一致していることを確認しています。変数 `server_name` の値が変わっていないためレンダリング結果も同じになり、`changed=0` を返しています。

---

[↑ 目次に戻る](#-目次)

---

## 5. changedは「差分検出結果」である

`changed=1` はよく「変更が成功した」という意味で読まれます。しかし正確には「差分が検出された」という意味です。

`file` モジュールを例にすると、処理の流れはこのようになります。

```
現在の状態を観測する
　↓
desired stateと比較する
　↓
差分あり → 変更を実行 → changed=1
差分なし → 何もしない → changed=0（ok）
```

`changed=1` は「差分があったので変更した」という結果です。`changed=0` は「差分がなかったので何もしなかった」という結果です。どちらも差分検出の結果として返されています。

**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** で確認した `changed_when: false` の場合と比較すると、意味の違いが明確になります。冪等なモジュールの `ok` は「差分なし」という観測結果を反映しています。`changed_when: false` の `ok` は観測の結果ではなく、表示の設定です。


---

[↑ 目次に戻る](#-目次)

---

## 6. 「変更しない能力」はなぜ重要なのか

Ansibleの自動化というと「自動的に変更を加える」という側面が注目されがちです。しかし実運用で重要になるのは「不要な変更を加えない」という側面です。

例えば、設定ファイルの配置タスクがあり、その後に `notify` でサービスのrestartが登録されているとします。


```yaml
- name: 設定ファイルを配置する
  ansible.builtin.template:
    src: templates/nginx.conf.j2
    dest: /etc/nginx/nginx.conf
  notify: nginx を再起動する
```

`template` モジュールが `changed=0` を返した場合、`notify` は発火しません。nginxは再起動されません。

設定ファイルの内容が変わっていないのにサービスが再起動されると、進行中のリクエストが切れます。`template` モジュールが差分検出を正しく行うことで、そのような不要なrestartを防いでいます。

`changed=0` は「何も起きなかった」ではなく「変更が不要であることを確認した上で何もしなかった」という状態です。この「変更しない能力」が、冪等なモジュールの実用上の価値の中心にあります。


---

[↑ 目次に戻る](#-目次)

---

## 7. 差分検出には限界がある

ここまで見てきたように、`file` / `copy` / `template` モジュールは実行前に現在の状態を観測し、差分を比較しています。この仕組みが正しく機能している限り、冪等な動作が維持されます。

ただし、この差分検出は「Ansibleが観測できる情報の範囲」でしか機能しません。moduleはファイルのchecksumやメタデータを見ています。ファイルの「意味」を理解しているわけではありません。

そのため、人間には「同じ設定」に見えても、Ansibleの観測上は「別の状態」として検出されるケースが存在します。その結果、`template` モジュールを使っていても毎回 `changed=1` になる、といった状況が起こります。

差分検出が具体的にどのような場面で壊れるのかは、次回の第3回で取り上げます。


---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

- **`file` モジュールは存在有無・種別・owner・group・modeを比較する**。全項目で差分がなければ `changed=0` を返す。
- **`copy` モジュールはchecksumとメタデータを比較する**。内容が同じであれば転送は行われない。
- **`template` モジュールはレンダリング後の出力のchecksumを比較する**。変数の値が変わらない限り、2回目以降は `changed=0` になる。
- **`changed` は差分検出の結果である**。`changed=1` は「差分があったので変更した」、`changed=0` は「差分がなかったので何もしなかった」という意味。
- **「変更しない能力」が冪等性の実用上の価値の中心にある**。不要なrestartを防ぎ、安定した運用を支えている。


---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

次回は、moduleを使っていても **毎回 `changed=1` になる問題** を扱います。`template` や `copy` を正しく使っているにもかかわらず、実行のたびに差分が検出される現象の原因を解説します。

- **差分検出が壊れる代表的なパターン**
- **「人間には同じに見える」のにAnsibleが別状態と判断するケース**
- **実務でよく遭遇する非冪等の原因と対処**

**[次回：第3回：なぜファイル操作は簡単に非冪等になるのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)**

---

📑 連載の移動　**[前の記事：【冪等性編】 第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)　｜　[次の記事：【冪等性編】 第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)**

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
