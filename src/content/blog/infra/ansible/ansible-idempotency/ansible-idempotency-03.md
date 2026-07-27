---
title: '「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第3回：なぜファイル操作は簡単に非冪等になるのか'
description: '改行コード、owner/group、Jinja2レンダリング差分など、「見えない差分」が changed を発生させる構造を理解する。'
pubDate: '2026-07-27'
category: 'infra'
tags: ['Ansible', '冪等性', 'idempotency', 'shell', 'command']
seriesId: 'ansible-idempotency'
seriesNo: 3
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-02/'
nextPost: ''
relatedSeries: ''
---


---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 シリーズまとめブログ** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [改行コードの違いで差分が出る](#2-改行コードの違いで差分が出る)
3. [Jinja2のwhitespace制御でレンダリング結果が変わる](#3-jinja2のwhitespace制御でレンダリング結果が変わる)
4. [owner/groupの名前解決によるずれ](#4-ownergroupの名前解決によるずれ)
5. [差分検出が壊れる共通構造](#5-差分検出が壊れる共通構造)
6. [まとめ](#6-まとめ)
7. [次回予告](#7-次回予告)
8. [連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 ](#8-連載一覧ansibleは本当に冪等なのか冪等性が崩れる構造と設計)


---

## 1. はじめに

**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-02/)** では、`file` / `copy` / `template` モジュールが現在の状態を観測し、desired stateと比較することで `changed=0` を返せる仕組みを説明しました。また、その差分検出は「Ansibleが観測できる情報の範囲」でしか機能しないという点にも触れました。

今回はその続きとして、差分検出が具体的にどのような場面で壊れるのかを取り上げます。`copy` や `template` を正しく使っているにもかかわらず、意図しない `changed=1` になるケースがあります。原因は「人間には同じに見えるが、Ansibleの観測上は別の状態として検出される」という構造にあります。この回では、その代表的なパターンを説明します。なお、検証環境で再現できたパターンについては実機での確認結果を合わせて示します。


---

[↑ 目次に戻る](#-目次)

---

## 2. 改行コードの違いで差分が出る

`copy` モジュールはファイルの内容比較にchecksumを使います。checksumはバイト列をそのまま計算するため、改行コードが異なるファイルは内容が同じに見えても別のchecksumになります。

Linuxの改行コードはLF（`\n`）ですが、Windowsで作成したファイルはCRLF（`\r\n`）になります。Git経由でファイルを管理している場合も、`core.autocrlf` の設定によってはチェックアウト時に改行コードが変換され、意図せずCRLFファイルがコントローラーノードに置かれることがあります。

この状態でcopyモジュールを実行すると、転送元（CRLF）と転送先（LF）のchecksumが一致しないため、毎回 `changed=1` になります。ファイルの内容を目視で確認しても違いは分かりません。`cat` で表示される内容は同じに見えますが、バイト列としては別物です。

この問題はWindowsマシンでPlaybookを管理しGit経由でLinuxのコントローラーノードに持ち込む構成で発生しやすいです。Gitの `core.autocrlf` を `false` に設定するか、`.gitattributes` で改行コードを明示的に制御することで回避できます。


---

[↑ 目次に戻る](#-目次)

---

## 3. Jinja2のwhitespace制御でレンダリング結果が変わる

`template` モジュールはJinja2テンプレートをレンダリングした結果のchecksumを比較します。テンプレートファイル自体に変更がなくても、レンダリング結果に意図しない空白や改行が含まれていると、転送先のファイルと毎回checksumの差分が出ます。

Jinja2の制御構文（`{% if %}` や `{% for %}` など）を使う場合、ブロックタグの前後に改行が残るかどうかは `trim_blocks` / `lstrip_blocks` の設定に依存します。この設定を明示しない場合、意図しない空白・改行がレンダリング結果に混入し、手動でファイルを編集した後に再実行すると `changed=1` になります。

この動作を実際に確認します。`trim_blocks` / `lstrip_blocks` を設定していないテンプレートを配置した後、リモートノード側で余分な改行を手動削除し、再実行したときの挙動を見ます。

---

### ■ 検証内容（Jinja2 whitespaceによる差分検出）

**【コントローラーノード側】**

事前にテンプレートファイルを作成しておきます。


```plaintext
(ansible) [ansible@localhost workspace]$ cat templates/nginx_notrim.conf.j2
server_name {{ server_name }};
  {% if enable_gzip %}
gzip on;
  {% endif %}
```

**ファイル名: `test_whitespace.yml`**


```yaml
---
- name: Jinja2 whitespaceによる差分検出確認
  hosts: test_servers
  gather_facts: false
  become: true

  vars:
    server_name: localhost
    enable_gzip: true

  tasks:
    - name: テンプレートを配置する（trim_blocks未設定）- ノード1
      ansible.builtin.template:
        src: templates/nginx_notrim.conf.j2
        dest: /tmp/nginx_whitespace.conf
        owner: ansibleuser
        group: ansibleuser
        mode: '0644'
      when: inventory_hostname == '192.168.1.21'

    - name: テンプレートを配置する（trim_blocks未設定）- ノード2
      ansible.builtin.template:
        src: templates/nginx_notrim.conf.j2
        dest: /tmp/nginx_whitespace.conf
        owner: ansibleuser2
        group: ansibleuser2
        mode: '0644'
      when: inventory_hostname == '192.168.1.22'
```

---

#### ■ 1回目の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_whitespace.yml
```

**▼ 1回目の実行結果**

```plaintext
PLAY [Jinja2 whitespaceによる差分検出確認] **************************************************************************************************************************************************

TASK [テンプレートを配置する（trim_blocks未設定）- ノード1] *********************************************************************************************************************************
skipping: [192.168.1.22]
changed: [192.168.1.21]

TASK [テンプレートを配置する（trim_blocks未設定）- ノード2] *********************************************************************************************************************************
skipping: [192.168.1.21]
changed: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

**【1回目のリモートノード側の確認】**

レンダリング結果を確認します。

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ cat -A /tmp/nginx_whitespace.conf
server_name localhost;$
  gzip on;$
  $
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ cat -A /tmp/nginx_whitespace.conf
server_name localhost;$
  gzip on;$
  $
```

---

両方のリモートノード側で余分な改行を手動削除します。

```plaintext
# 両ノードで実行
vi /tmp/nginx_whitespace.conf
```

【変更前】
```plaintext
server_name localhost;
  gzip on;
```


【変更後】
```plaintext
server_name localhost;
gzip on;
```



---

#### ■ 2回目の実行

手動編集後に再度Playbookを実行します。

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_whitespace.yml
```

**▼ 2回目の実行結果**

```plaintext
PLAY [Jinja2 whitespaceによる差分検出確認] **************************************************************************************************************************************************

TASK [テンプレートを配置する（trim_blocks未設定）- ノード1] *********************************************************************************************************************************
skipping: [192.168.1.22]
changed: [192.168.1.21]

TASK [テンプレートを配置する（trim_blocks未設定）- ノード2] *********************************************************************************************************************************
skipping: [192.168.1.21]
changed: [192.168.1.22]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=1    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
192.168.1.22               : ok=1    changed=1    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

**【2回目のリモートノード側の確認】**

- リモートノード1（192.168.1.21）

```plaintext
[ansibleuser@localhost ~]$ cat -A /tmp/nginx_whitespace.conf
server_name localhost;$
  gzip on;$
  $
```

- リモートノード2（192.168.1.22）

```plaintext
[ansibleuser2@localhost ~]$ cat -A /tmp/nginx_whitespace.conf
server_name localhost;$
  gzip on;$
  $
```

---

### ■ 結果

1回目は両ノードで `changed=1` となり、テンプレートのレンダリング結果が転送されました。

リモートノード側でレンダリング結果を確認すると、`{% if %}` タグのインデント（スペース2つ）が `gzip on;` の行と末尾の空行に残っていることが分かります。テンプレートファイル上では `{% if %}` / `{% endif %}` タグ行にインデントを入れているため、`lstrip_blocks` が未設定の状態ではそのインデントがレンダリング結果に混入します。

両ノードで手動編集によりインデントと余分な空行を削除した後、2回目の実行を行いました。2回目も両ノードで `changed=1` となりました。

リモートノード側を確認すると、手動で削除したはずのインデントと空行が再び元に戻っています。templateモジュールは2回目の実行時にテンプレートを再度レンダリングし、その結果のchecksumと転送先ファイルのchecksumを比較しています。手動編集後のファイルはインデントが除去された状態であるため、レンダリング結果と一致せず `changed=1` になっています。

`when` 条件によって各ノードは自分宛てでないタスクを `skipping` しています。PLAY RECAPの `skipped=1` はその反映であり、差分検出の結果には影響しません。



---

[↑ 目次に戻る](#-目次)

---


## 4. owner/groupの名前解決によるずれ

`file` / `copy` / `template` モジュールで `owner` や `group` を指定する場合、Ansibleはリモートノード上でその名前をUID/GIDに解決してから比較します。

複数のノードを管理する構成では、同じユーザー名でもノードごとにUID/GIDが異なる場合があります。例えば、ノードを手動でセットアップした環境では、ユーザー作成の順序によってUID/GIDが揃わないことがあります。この場合、あるノードでは `changed=0` になるのに別のノードでは `changed=1` になる、という状況が起きます。

また、Playbookで名前指定（`owner: appuser`）をしている一方、ファイルシステム上にはUID直指定で作成されたファイルが存在する場合も同様です。名前解決の結果が一致しなければ、差分として検出されます。

この問題が起きやすい場面を整理すると以下のとおりです。

- 複数ノードで同じユーザー名のUID/GIDが異なる（手動セットアップ環境で起きやすい）
- Playbookでは名前指定、ファイルシステム上はUID直指定という混在
- ノード追加時に既存のUID/GIDと重複しないよう別のIDが割り当てられた

今回の検証環境ではUID/GIDが揃っているため安定した再現が難しく、検証は行いません。複数ノードを管理する構成でユーザー管理をPlaybook外で行っている場合には注意が必要です。

---

[↑ 目次に戻る](#-目次)

---

## 5. 差分検出が壊れる共通構造

セクション2〜4で見てきたパターンに共通しているのは、「Ansibleが観測しているのはバイト列とメタデータであり、設定の意味ではない」という点です。

`copy` モジュールがchecksumを比較するとき、それはファイルのバイト列が一致しているかどうかの確認です。改行コードが違えばバイト列が変わるため、内容が同じに見えても差分として検出されます。`template` モジュールがレンダリング結果を比較するときも同様で、whitespaceの有無はバイト列の差として現れます。owner/groupの名前解決がノード間でずれている場合も、Ansibleの観測上は「desired stateと一致していない」という差分として検出されます。

これらはいずれも「設定として意味的には同じ」「Ansibleの観測上は別の状態」という構造を持っています。差分検出の仕組み自体は正しく動いています。しかし比較している対象が人間の意図と一致していないために、意図しない `changed=1` として現れます。


---

[↑ 目次に戻る](#-目次)

---

## 6. まとめ

- **改行コードの違いはchecksumの差分として検出される**。コントローラーノードのファイルがCRLFであれば、転送先がLFのLinuxノードでは毎回差分が出る。Gitの `core.autocrlf` の設定や `.gitattributes` で改行コードを明示的に制御することで回避できる。
- **Jinja2のwhitespace制御はレンダリング結果のバイト列に影響する**。`lstrip_blocks` が未設定の状態でタグ行にインデントを入れると、意図しないスペースや空行がレンダリング結果に混入し、checksumの差分として現れる。
- **owner/groupの名前解決はリモートノード上で行われる**。ノード間でUID/GIDが異なる場合、同じ名前指定でも差分として検出されることがある。
- **差分検出が壊れる原因は、Ansibleが意味ではなくバイト列とメタデータを見ているため**。人間には同じに見えても、Ansibleの観測上は別の状態として検出される。


---

[↑ 目次に戻る](#-目次)

---

## 7. 次回予告

今回は、moduleを正しく使っていても差分検出が壊れるパターンを見ました。これらはいずれも「desired stateの記述は正しいが、Ansibleの観測と人間の意図がずれている」という問題です。

次回はさらに別の問題に進みます。desired stateの記述そのものが固定されていないケースです。

**次回：第4回：なぜ"最新化"は冪等性を壊すのか ※近日公開予定**

`state: latest` のようにdesired stateが実行時点の外部状態に依存する場合、同じPlaybookを2回実行しても結果が変わります。第3回が「差分検出の破綻」なら、第4回は「desired state自体の不安定さ」を扱います。

---

📑 連載の移動　**[前の記事：【冪等性編】 第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-02/)　｜　次の記事：【冪等性編】 第4回**  **※近日公開予定**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 シリーズまとめブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 8. 連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 

| 回    | タイトル                            | 内容（概要）                                                                                               |
| ---- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **[第0回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-00/)**  | なぜAnsibleは「何度実行しても安全」だと思われているのか | 冪等性（idempotency）の本来の意味を整理し、「同じコマンドを繰り返せる」ことと「状態が収束する」ことの違いを理解する。                                     |
| **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)**  | shellモジュールはなぜ“状態”を扱えないのか        | shell/command が desired state を持てない理由を構造から整理する。changed_when は表示制御であり、冪等性保証ではないことを理解する。               |
| **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-02/)**  | なぜAnsible moduleは「変更不要」を判断できるのか | file/copy/template などの module が、現在状態と desired state の差分比較によって動作していることを理解する。Ansibleが宣言的管理に見える理由を整理する。 |
| 第3回  | なぜファイル操作は簡単に非冪等になるのか            | 改行コード、owner/group、Jinja2レンダリング差分など、「見えない差分」が changed を発生させる構造を理解する。                          |
| 第4回  | なぜ“最新化”は冪等性を壊すのか                | yum/apt の state: latest やバージョン未固定が、再実行ごとに状態を変化させる理由を理解する。desired state と「現在の最新版」は別物であることを学ぶ。         |
| 第5回  | なぜサービス制御は再起動ループを生むのか            | service/systemd/handler の notify 連鎖を通して、「変更検知」がどのように状態遷移を引き起こすのかを理解する。reload/restart の違いも整理する。       |
| 第6回  | なぜlineinfileは“安全そうに見えて危険”なのか    | lineinfile は「状態管理」ではなく「部分パッチ」である。正規表現・重複挿入・文脈依存編集によって冪等性が崩れる構造を理解する。                                 |
| 第7回  | なぜ同じPlaybookなのに環境ごとに結果が変わるのか    | OS・ディストリビューション・systemd・Python・locale 差分によって、module の内部動作が変化することを理解する。                                |
| 第8回  | なぜタスクの依存関係は冪等性を壊すのか             | handler、register、条件分岐、タスク順序によって「前回実行結果」に依存したPlaybookが生まれる。状態遷移が閉じなくなる理由を整理する。                        |
| 第9回  | 冪等性はどうやって検証すべきなのか               | check mode の限界、diff mode、molecule、CI、自動テストを通して、「2回目 changed=0」をどう保証するのかを理解する。                        |
| 第10回 | 「冪等に設計する」とは何を設計することなのか          | imperative（手続き）ではなく declarative（状態宣言）としてPlaybookを設計する考え方を整理し、「壊れない構成管理」の原則を完成させる。                    |


---

[↑ 目次に戻る](#-目次)

---
