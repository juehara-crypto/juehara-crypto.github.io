---
title: '「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第6回：なぜlineinfileは“安全そうに見えて危険”なのか'
description: 'lineinfile は「状態管理」ではなく「部分パッチ」である。正規表現・重複挿入・文脈依存編集によって冪等性が崩れる構造を理解する。'
pubDate: '2026-07-28'
category: 'infra'
tags: ['Ansible', '冪等性', 'idempotency', 'lineinfile', 'insertafter', 'insertbefore', 'desired state']
seriesId: 'ansible-idempotency'
seriesNo: 6
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-05/'
nextPost: ''
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
2. [lineinfileは何をしているのか](#2-lineinfileは何をしているのか)
3. [regexpが曖昧だと何が起きるか](#3-regexpが曖昧だと何が起きるか)
4. [一致しないと行が追加される](#4-一致しないと行が追加される)
5. [insertafterは挿入位置を固定しない](#5-insertafterは挿入位置を固定しない)
6. [desired stateが閉じていない](#6-desired-stateが閉じていない)
7. [shellより安全、しかし管理粒度は違う](#7-shellより安全しかし管理粒度は違う)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜](#10-連載一覧ansibleは本当に冪等なのか冪等性が崩れる構造と設計)

---

## 1. はじめに

**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-05/)** では、`changed=1` が `notify` と `handler` を通じてサービスの再起動を引き起こす構造を確認しました。意図しない `changed=1` は表示上の問題にとどまらず、実際の状態遷移につながります。

今回はさらに別の問題に進みます。`changed` が発生するかどうかの前に、そもそも「変更対象を正しく定義できているのか」という問いです。

この回では `lineinfile` モジュールを取り上げます。一見するとAnsibleらしい宣言的な記述に見えますが、その動作は `template` や `copy` とは構造的に異なります。何が違うのかを順に見ていきます。


---

[↑ 目次に戻る](#-目次)

---

## 2. lineinfileは何をしているのか

`lineinfile` モジュールが何をしているのかを整理します。

`template` モジュールはファイル全体をdesired stateとして扱います。Playbookに指定したテンプレートのレンダリング結果が、そのままリモートノード上のファイルの最終状態になります。

```yaml
- name: 設定ファイルを配置する
  ansible.builtin.template:
    src: templates/app.conf.j2
    dest: /etc/app.conf
```

このタスクが `changed=0` を返す場合、「ファイル全体の内容がテンプレートのレンダリング結果と一致している」という意味です。

`lineinfile` は異なります。

```yaml
- name: タイムアウト値を設定する
  ansible.builtin.lineinfile:
    path: /etc/app.conf
    regexp: '^timeout='
    line: 'timeout=30'
```

このタスクがやっていることは「`/etc/app.conf` の中から `^timeout=` に一致する行を探し、あれば `timeout=30` に書き換え、なければ追加する」という操作です。ファイル全体の状態は関与していません。

`template` が「このファイルはこうあるべき」という宣言であるのに対し、`lineinfile` は「この行をこう書き換えろ」という局所的な操作指示です。ファイル全体ではなく一部分だけを対象にする、いわば局所パッチとして動作します。


---

[↑ 目次に戻る](#-目次)

---

## 3. regexpが曖昧だと何が起きるか

`lineinfile` モジュールの `regexp` パラメータは、編集対象の行を特定するための正規表現です。このパラメータが「意味」ではなく「文字列」として一致する点を確認します。

例えば以下のような指定があるとします。

```yaml
regexp: 'timeout'
```

この指定は `^timeout=` だけに一致するわけではありません。以下のような行にも一致します。

- `# timeout=10`（コメント行）
- `proxy_timeout=30`（別のディレクティブ）
- `connect_timeout=5`（別のディレクティブ）

`lineinfile` は行の「意味」を理解していません。正規表現が文字列として一致するかどうかだけを見ています。そのため `regexp` の指定が曖昧だと、意図した行とは別の行が書き換え対象になります。

この動作を実際に確認します。複数の `timeout` 関連行を含む設定ファイルに対して、曖昧な `regexp` を使ったときに何が起きるかを見ます。

---

### ■ 検証内容（regexpの曖昧一致）

**【コントローラーノード側】**

事前に対象ファイルをリモートノードに配置しておきます。

```plaintext
cat > files/app.conf << 'EOF'
# timeout=10
proxy_timeout=30
connect_timeout=5
timeout=10
EOF
```

**ファイル名: `test_regexp_ambiguous.yml`**

```yaml
---
- name: regexpの曖昧一致確認
  hosts: test_servers
  gather_facts: false
  become: true

  tasks:
    - name: 対象ファイルを配置する
      ansible.builtin.copy:
        src: files/app.conf
        dest: /tmp/app.conf
        owner: root
        group: root
        mode: '0644'

    - name: 'timeoutを設定する（曖昧なregexp）'
      ansible.builtin.lineinfile:
        path: /tmp/app.conf
        regexp: 'timeout'
        line: 'timeout=30'
```

---

#### ■ 実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_regexp_ambiguous.yml
```

**▼ 実行結果**

```plaintext
PLAY [regexpの曖昧一致確認] *****************************************************************************************************************************************************************

TASK [対象ファイルを配置する] ***************************************************************************************************************************************************************
changed: [192.168.1.21]
changed: [192.168.1.22]

TASK [timeoutを設定する（曖昧なregexp）] ****************************************************************************************************************************************************
changed: [192.168.1.21]
changed: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```


**【リモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ cat /tmp/app.conf
# timeout=10
proxy_timeout=30
connect_timeout=5
timeout=30
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ cat /tmp/app.conf
# timeout=10
proxy_timeout=30
connect_timeout=5
timeout=30
```


---

### ■ 結果

両ノードともに `changed=1` となり、`timeout=10` の行が `timeout=30` に書き換えられました。

ここで確認しておきたいのは、`regexp: 'timeout'` がどの行に一致したかです。対象ファイルには `timeout` を含む行が4行あります。

- `# timeout=10`
- `proxy_timeout=30`
- `connect_timeout=5`
- `timeout=10`

`lineinfile` は複数の行が一致した場合、最後に一致した行を書き換えます。今回は `timeout=10` が最後の一致行となり、この行が `timeout=30` に置き換えられています。

結果としては意図した行が書き換えられていますが、それは `timeout=10` がたまたまファイルの末尾に位置していたからです。ファイルの順序が変わって `# timeout=10` や `proxy_timeout=30` が末尾になれば、それらが書き換え対象になります。

`lineinfile` は「どの行を書き換えるべきか」を意味から判断しません。正規表現に文字列として一致した行の中から、機械的に最後の行を選んでいます。`regexp` の精度が低いと、意図した行への操作は保証されません。

---

[↑ 目次に戻る](#-目次)

---

## 4. 一致しないと行が追加される

`regexp` に一致する行が見つからなかった場合、`lineinfile` はファイルの末尾に `line` の内容を追加します。

例えば以下のような指定があるとします。

```yaml
regexp: '^timeout='
line: 'timeout=30'
```

対象ファイルに `  timeout=10`（行頭にスペースあり）という行が存在する場合、`^timeout=` には一致しません。一致する行がないため、`timeout=30` がファイルの末尾に追加されます。2回目以降の実行では、追加された `timeout=30` が `^timeout=` に一致し、その内容が `line: 'timeout=30'` と同じであるため変更不要と判断され、`changed=0` になります。

この動作の問題は「毎回増える」ことではありません。1回目の実行で意図した行（`  timeout=10`）とは別の行（`timeout=30`）が追加され、その後はその追加行が管理対象になるという点です。元の `  timeout=10` はファイルに残ったままで、どちらが有効になるかはアプリケーション側の解釈に依存します。

この動作を実際に確認します。`regexp` が一致しない状態を作り、同じPlaybookを2回実行したときの挙動を見ます。

---

### ■ 検証内容（regexp不一致による重複追加）

**【事前確認】リモートノード側への初期ファイル配置**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ echo "  timeout=10" > /tmp/app2.conf
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ echo "  timeout=10" > /tmp/app2.conf
```

**ファイル名: `test_regexp_nomatch.yml`**

```yaml
---
- name: regexp不一致による重複追加確認
  hosts: test_servers
  gather_facts: false
  become: true

  tasks:
    - name: 'timeoutを設定する（行頭固定regexp）'
      ansible.builtin.lineinfile:
        path: /tmp/app2.conf
        regexp: '^timeout='
        line: 'timeout=30'
```

---

#### ■ 1回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_regexp_nomatch.yml
```

**▼ 1回目の実行結果**

```plaintext
PLAY [regexp不一致による重複追加確認] *******************************************************************************************************************************************************

TASK [timeoutを設定する（行頭固定regexp）] **************************************************************************************************************************************************
changed: [192.168.1.21]
changed: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【1回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ cat /tmp/app2.conf
  timeout=10
timeout=30
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ cat /tmp/app2.conf
  timeout=10
timeout=30
```

---

#### ■ 2回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_regexp_nomatch.yml
```

**▼ 2回目の実行結果**

```plaintext
PLAY [regexp不一致による重複追加確認] *******************************************************************************************************************************************************

TASK [timeoutを設定する（行頭固定regexp）] **************************************************************************************************************************************************
ok: [192.168.1.21]
ok: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ cat /tmp/app2.conf
  timeout=10
timeout=30
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ cat /tmp/app2.conf
  timeout=10
timeout=30
```

---

### ■ 結果

1回目の実行では両ノードで `changed=1` となり、`timeout=30` がファイルの末尾に追加されました。`^timeout=` はインデントあり行の `  timeout=10` には一致しないため、一致なしと判定され追加が実行されています。

2回目の実行では両ノードで `changed=0` となりました。1回目で追加された `timeout=30` が `^timeout=` に一致し、内容も `line: 'timeout=30'` と同じでした。Ansible公式ドキュメントにはこの場合の動作が明示されていませんが、検証環境（Ansible core 2.15.13）では `changed=0` となることを確認しています。

リモートノード側を確認すると、`  timeout=10`（元の行）と `timeout=30`（追加された行）が共存しています。`lineinfile` は `regexp` に一致する行を書き換えますが、一致しなかった既存行はそのまま残ります。どちらの設定が有効になるかはアプリケーション側の解釈に依存しており、Ansible側では保証されません。

---

#### 参考

- [ansible.builtin.lineinfile module – Manage lines in text files — Ansible Community Documentation](https://docs.ansible.com/ansible/latest/collections/ansible/builtin/lineinfile_module.html)

---

[↑ 目次に戻る](#-目次)

---

## 5. insertafterは挿入位置を固定しない

`lineinfile` には `insertafter` / `insertbefore` というパラメータがあります。これらは `regexp` が一致しなかった場合に、行をどの位置に挿入するかを指定するものです。

なお、`regexp` が正しく機能していれば一致行の書き換えが優先されるため、`insertafter` / `insertbefore` は動作しません。このセクションでは `regexp` を指定しない場合、または `regexp` が一致しない場面に限定して説明します。

例えば以下のような指定があるとします。

```yaml
- name: server blockの前にタイムアウト設定を追加する
  ansible.builtin.lineinfile:
    path: /etc/app.conf
    line: 'timeout=30'
    insertbefore: '^server'
```

この指定は「`^server` に一致する行の前に `timeout=30` を挿入する」という操作です。`^server` に一致する行が存在する間は意図どおりに動作します。しかしファイル構造が変わって `^server` に一致する行がなくなった場合、`insertbefore` は機能せず、`line` の内容はファイルの末尾に追加されます。

`insertafter: EOF` を使った場合も同様です。挿入位置として「ファイルの末尾」を指定していますが、これはファイルの現在の末尾への追加であり、ファイル全体の構造を管理しているわけではありません。

`insertafter` / `insertbefore` が依存しているのはファイルの現在の内容です。upstreamの更新や手動編集でファイル構造が変わると、意図した位置への挿入が保証されなくなります。挿入位置をファイルの構造から独立して固定する手段を `lineinfile` は持っていません。


---

[↑ 目次に戻る](#-目次)

---

## 6. desired stateが閉じていない

セクション2〜5で見てきた内容を構造として整理します。

`template` モジュールはファイル全体をdesired stateとして扱います。Playbookに指定したテンプレートのレンダリング結果がそのままファイルの最終状態になるため、desired stateはPlaybook内で完結しています。同じPlaybookを何度実行しても、ファイルの最終状態は同じになります。

`lineinfile` は異なります。セクション3〜5で確認したとおり、`lineinfile` の動作結果はファイルの現在の内容に依存します。

| 依存要素 | 影響 |
|---|---|
| 既存行の内容 | `regexp` が一致するかどうかが変わる |
| 行の順序 | 複数一致した場合にどの行が書き換えられるかが変わる |
| コメント行の有無 | 意図しない行に一致する可能性がある |
| 前回の編集結果 | 追加された行が次回の一致対象になる |

これらはいずれもPlaybookの外にある要素です。同じPlaybookを実行しても、ファイルの現在の状態によって結果が変わります。

`template` のdesired stateがPlaybook内で閉じているのに対し、`lineinfile` のdesired stateはファイルの現在の内容という外部要素に開いています。この構造が、`lineinfile` を使ったPlaybookで冪等性が崩れやすい根本的な原因です。

---

[↑ 目次に戻る](#-目次)

---

## 7. shellより安全、しかし管理粒度は違う

ここまでの内容を踏まえて、`lineinfile` の位置づけを整理します。

`lineinfile` は `shell` モジュールで `sed` や `awk` を直接実行する方法と比べると安全です。`shell` モジュールはコマンドを実行するだけで状態を観測しませんが、`lineinfile` は対象行を探してから操作するという手順を持っています。また `regexp` に一致する行がすでに `line` と同じ内容であれば変更を行わないという動作も、`shell` で `sed` を直接実行する場合にはない仕組みです。

しかし「shellより安全」と「ファイル全体の状態を管理している」は別の話です。

`template` や `copy` はファイル全体をdesired stateとして扱います。`lineinfile` は特定の行への局所操作です。この管理粒度の違いは「どちらが優れているか」ではなく、「何を管理しているか」の違いです。

| モジュール | 管理対象 | desired stateの範囲 |
|---|---|---|
| `template` | ファイル全体 | Playbook内で閉じている |
| `copy` | ファイル全体 | Playbook内で閉じている |
| `lineinfile` | 特定の行 | ファイルの現在の内容に依存する |
| `shell`（sed等） | コマンドの実行 | 状態管理なし |

`lineinfile` が適している場面もあります。ファイル全体をテンプレートで管理することが難しい場合、例えば他のツールやプロセスが同じファイルを管理していて上書きできない場合や、大きな設定ファイルの一部だけを変更したい場合などです。

重要なのは、`lineinfile` を使う場合に「ファイル全体の状態は保証されていない」という認識を持つことです。局所パッチとして使う場面では有効ですが、ファイル全体の状態管理が必要な場面では `template` や `copy` を使うのが適切です。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

- **`lineinfile` は局所パッチとして動作する**。`template` や `copy` がファイル全体をdesired stateとして扱うのに対し、`lineinfile` は特定の行への編集操作を行うだけで、ファイル全体の状態は関与しない。
- **`regexp` は意味ではなく文字列として一致する**。指定が曖昧だと意図した行とは別の行が書き換え対象になる。複数行が一致した場合は最後の一致行が書き換えられる。
- **`regexp` が一致しない場合は末尾に追加される**。インデントや空白の違いで一致しなかった場合、意図した行とは別の行が追加され、元の行と共存する状態になる。`regexp` が一致しなかった既存行はファイルに残ったままになる。
- **`insertafter` / `insertbefore` の挿入位置はファイルの現在の内容に依存する**。ファイル構造が変わると挿入位置がずれる可能性がある。
- **`lineinfile` のdesired stateはファイルの現在の内容に開いている**。既存行・順序・コメント・前回の編集結果によって動作結果が変わるため、同じPlaybookを実行しても結果が一定にならない場合がある。
- **shellより安全だが、管理粒度は `template` / `copy` と異なる**。「安全」と「ファイル全体の状態管理」は別の概念であり、`lineinfile` は局所編集が必要な場面での使用に限定するのが適切である。

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

今回は、`lineinfile` がファイル全体の状態を管理しているのではなく、局所パッチとして動作するという構造を見ました。desired stateがファイルの現在の内容に依存するため、同じPlaybookを実行しても結果が変わる場合があります。

次回はさらに別の問題に進みます。Playbookの記述もモジュールの使い方も正しいにもかかわらず、実行する環境によって結果が変わるケースです。

**次回：第7回：なぜ同じPlaybookなのに環境ごとに結果が変わるのか**

OS・ディストリビューション・Python・locale・systemdのバージョン差分によって、同じモジュールの内部動作が変化することがあります。第6回が「編集対象の曖昧さ」であれば、第7回は「実行環境の曖昧さ」を扱います。



---

📑 連載の移動　**[前の記事：【冪等性編】 第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-05/)　｜　[次の記事：【冪等性編】 第7回]**

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
| 第7回  | なぜ同じPlaybookなのに環境ごとに結果が変わるのか    | OS・ディストリビューション・systemd・Python・locale 差分によって、module の内部動作が変化することを理解する。                                |
| 第8回  | なぜタスクの依存関係は冪等性を壊すのか             | handler、register、条件分岐、タスク順序によって「前回実行結果」に依存したPlaybookが生まれる。状態遷移が閉じなくなる理由を整理する。                        |
| 第9回  | 冪等性はどうやって検証すべきなのか               | check mode の限界、diff mode、molecule、CI、自動テストを通して、「2回目 changed=0」をどう保証するのかを理解する。                        |
| 第10回 | 「冪等に設計する」とは何を設計することなのか          | imperative（手続き）ではなく declarative（状態宣言）としてPlaybookを設計する考え方を整理し、「壊れない構成管理」の原則を完成させる。                    |

---

[↑ 目次に戻る](#-目次)

---