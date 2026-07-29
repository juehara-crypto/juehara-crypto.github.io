---
title: '「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第7回：なぜ同じPlaybookなのに環境ごとに結果が変わるのか'
description: 'OS・ディストリビューション・systemd・Python・locale 差分によって、module の内部動作が変化することを理解する。'
pubDate: '2026-07-28'
category: 'infra'
tags: ['Ansible', '冪等性', 'idempotency', 'module', 'Python', 'locale', 'gather_facts', 'systemd']
seriesId: 'ansible-idempotency'
seriesNo: 7
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/'
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
2. [Playbookの記述とモジュールの内部処理は別である](#2-playbookの記述とモジュールの内部処理は別である)
3. [gather_factsはモジュールに何を伝えているのか](#3-gather_factsはモジュールに何を伝えているのか)
4. [localeの違いでモジュールの判定が変わる](#4-localeの違いでモジュールの判定が変わる)
5. [Pythonバージョンがモジュールの動作に影響する](#5-pythonバージョンがモジュールの動作に影響する)
6. [冪等性は実行環境込みで成立する](#6-冪等性は実行環境込みで成立する)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜](#9-連載一覧ansibleは本当に冪等なのか冪等性が崩れる構造と設計)

---

## 1. はじめに

**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/)** では、`lineinfile` モジュールがファイル全体の状態を管理するのではなく、特定の行への局所的な編集操作として動作する構造を確認しました。desired stateがファイルの現在の内容に依存するため、同じPlaybookを実行しても結果が変わる場合があります。これが「編集対象の曖昧さ」でした。

今回はさらに別の問題に進みます。モジュールの使い方もPlaybookの記述も正しいにもかかわらず、実行する環境によって結果が変わるケースです。

```yaml
- name: nginx を起動する
  ansible.builtin.service:
    name: nginx
    state: started
```

このタスクはどの環境でも同じように見えます。しかしモジュールの内部では、リモートノードの環境に応じて呼び出されるコマンドが変わります。Playbookの記述は「抽象命令」であり、実際に何が実行されるかは実行環境が決めています。

この回では、Ansibleモジュールの内部処理が実行環境に依存する構造と、それが冪等性にどう影響するかを整理します。これが「実行基盤の曖昧さ」です。

---

[↑ 目次に戻る](#-目次)

---

## 2. Playbookの記述とモジュールの内部処理は別である

Playbookの記述とモジュールが実際に行う処理が一対一に対応していない点を整理します。

以下のタスクを例にします。

```yaml
- name: nginx を起動する
  ansible.builtin.service:
    name: nginx
    state: started
```

この記述はどの環境でも同じです。しかしモジュールの内部では、リモートノードの環境に応じて呼び出されるコマンドが変わります。

|環境|モジュールが内部で呼び出すコマンド|
|---|---|
|systemd を使うLinux（Rocky Linux、Ubuntu等）|`systemctl start nginx`|
|SysVinit を使うLinux（一部の古いディストリビューション）|`service nginx start`|
|OpenRC を使うLinux（Gentoo等）|`rc-service nginx start`|

`package` モジュールも同様です。

```yaml
- name: nginx をインストールする
  ansible.builtin.package:
    name: nginx
    state: present
```

|環境|モジュールが内部で呼び出すコマンド|
|---|---|
|Rocky Linux / CentOS|`dnf install nginx`|
|Ubuntu / Debian|`apt install nginx`|
|openSUSE|`zypper install nginx`|

Playbookの記述は「nginxを起動した状態にする」「nginxをインストールした状態にする」という抽象的な命令です。その命令を実現するために何を呼び出すかは、モジュールが実行時にリモートノードの環境を確認して決めています。

「同じモジュール名を書く」ことと「同じコマンドが実行される」ことは別です。Playbookの記述が同一でも、リモートノードの環境が違えばモジュールが内部で呼び出すコマンドは変わります。

この「実行時にリモートノードの環境を確認して処理を決める」仕組みの中心にあるのが `gather_facts` です。次のセクションで確認します。


---

[↑ 目次に戻る](#-目次)

---

## 3. gather_factsはモジュールに何を伝えているのか

Ansibleがリモートノードの環境情報をどのように収集し、モジュールの内部処理に渡しているかを確認します。

Ansibleはplaybookの実行前に `gather_facts` を実行し、リモートノードの環境情報を収集します。この情報が、モジュールが内部で「どのコマンドを呼び出すか」を決める判断材料になっています。

実際にどのような情報が収集されるかを確認します。

---

### ■ 検証内容（gather_factsの出力確認）

**【コントローラーノード側】**

**ファイル名: `test_gather_facts.yml`**

```yaml
---
- name: gather_factsの出力確認
  hosts: test_servers
  gather_facts: true

  tasks:
    - name: OS種別・バージョンを表示する
      ansible.builtin.debug:
        msg:
          - 'ansible_distribution: {{ ansible_distribution }}'
          - 'ansible_distribution_version: {{ ansible_distribution_version }}'
          - 'ansible_os_family: {{ ansible_os_family }}'

    - name: サービスマネージャー・パッケージマネージャーを表示する
      ansible.builtin.debug:
        msg:
          - 'ansible_service_mgr: {{ ansible_service_mgr }}'
          - 'ansible_pkg_mgr: {{ ansible_pkg_mgr }}'

    - name: Pythonのパスを表示する
      ansible.builtin.debug:
        msg:
          - 'ansible_python.executable: {{ ansible_python.executable }}'
          - 'ansible_python.version.major: {{ ansible_python.version.major }}'
          - 'ansible_python.version.minor: {{ ansible_python.version.minor }}'
```

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_gather_facts.yml
```

---

**▼ 実行結果**

```plaintext
TASK [OS種別・バージョンを表示する] *********************************************************************************************************************************************************
ok: [192.168.1.21] => {
    "msg": [
        "ansible_distribution: Rocky",
        "ansible_distribution_version: 9.7",
        "ansible_os_family: RedHat"
    ]
}
ok: [192.168.1.22] => {
    "msg": [
        "ansible_distribution: Rocky",
        "ansible_distribution_version: 9.8",
        "ansible_os_family: RedHat"
    ]
}

TASK [サービスマネージャー・パッケージマネージャーを表示する] *******************************************************************************************************************************
ok: [192.168.1.21] => {
    "msg": [
        "ansible_service_mgr: systemd",
        "ansible_pkg_mgr: dnf"
    ]
}
ok: [192.168.1.22] => {
    "msg": [
        "ansible_service_mgr: systemd",
        "ansible_pkg_mgr: dnf"
    ]
}

TASK [Pythonのパスを表示する] ***************************************************************************************************************************************************************
ok: [192.168.1.21] => {
    "msg": [
        "ansible_python.executable: /usr/bin/python3",
        "ansible_python.version.major: 3",
        "ansible_python.version.minor: 9"
    ]
}
ok: [192.168.1.22] => {
    "msg": [
        "ansible_python.executable: /usr/bin/python3",
        "ansible_python.version.major: 3",
        "ansible_python.version.minor: 9"
    ]
}

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=4    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
192.168.1.22               : ok=4    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```


### 結果

両ノードともすべてのタスクが `ok` となり、環境情報が取得されました。

注目すべき点が1つあります。2つのノードで `ansible_distribution_version` の値が異なっています。ノード1（192.168.1.21）は `9.7`、ノード2（192.168.1.22）は `9.8` です。同じRocky Linuxでも、マイナーバージョンが異なる状態です。

サービスマネージャーとパッケージマネージャーは両ノードとも `systemd` と `dnf` で一致しています。Pythonも両ノードとも `/usr/bin/python3`（バージョン3.9）です。

この出力がモジュールの内部処理にどう影響するかを整理します。

|取得された情報|値|モジュールへの影響|
|---|---|---|
|`ansible_os_family`|RedHat|`package` モジュールがdnfを呼び出す判断に使われる|
|`ansible_service_mgr`|systemd|`service` モジュールがsystemctlを呼び出す判断に使われる|
|`ansible_pkg_mgr`|dnf|`package` モジュールが直接参照する|
|`ansible_python.executable`|/usr/bin/python3|モジュールの実行に使われるPythonのパス|

今回の検証環境では両ノードとも同じサービスマネージャー・パッケージマネージャー・Pythonを使っています。しかし `ansible_distribution_version` が異なるように、同じPlaybookを向ける環境でも取得される情報は必ずしも一致しません。この情報の差がモジュールの内部処理の分岐につながります。

---

[↑ 目次に戻る](#-目次)

---

## 4. localeの違いでモジュールの判定が変わる

localeの設定によってコマンド出力の言語が変わり、モジュールの状態判定に影響する可能性がある構造を説明します。

Ansibleは宣言型モジュール（`service` / `package` / `file` など）の実行時に、リモートノードのlocale設定に関わらず内部的に `LANG=C` を強制します。そのためコマンド出力は常に英語で返され、リモートノードのlocale設定がモジュールの判定に直接影響することはありません。

この動作はAnsibleの設定オプション `module_set_locale` に関係しています。このオプションはモジュール実行時にリモートノードへ `LANG` / `LC_MESSAGES` / `LC_ALL` を設定するかどうかを制御するもので、Ansible 2.1で追加された時点ではデフォルト `True`（locale設定を渡す）でしたが、Ansible 2.2でデフォルトが `False`（locale設定を渡さない）に変更されています。現在のAnsibleではデフォルトでlocale設定がモジュールに渡されないため、リモートノードのlocale設定はモジュールの判定に影響しません。

検証環境（Ansible core 2.15.13）でもこの動作を確認しています。リモートノードのlocaleを `en_US.UTF-8` と `ja_JP.UTF-8` の間で切り替えて `service` モジュールを実行しましたが、`changed` の判定に差は出ませんでした。

---
#### 参考

- [Ansible Configuration Settings — module_set_locale](https://docs.ansible.com/projects/ansible/latest/reference_appendices/config.html)
---

[↑ 目次に戻る](#-目次)

---

## 5. Pythonバージョンがモジュールの動作に影響する

AnsibleモジュールがリモートノードのPythonで動作する構造と、Pythonのバージョン差分がモジュールの内部処理に影響しうる点を整理します。

Ansibleモジュールの実体はPythonスクリプトです。Ansibleはコントローラーノードからリモートノードにモジュールを転送し、リモートノード上のPythonで実行します。このとき使われるPythonは、コントローラーノードのPythonではなくリモートノードにインストールされているPythonです。

セクション3のgather_facts確認で、両ノードのPython情報がすでに取得されています。

```plaintext
"ansible_python.executable: /usr/bin/python3"
"ansible_python.version.major: 3"
"ansible_python.version.minor: 9"
```

両ノードともPython 3.9が `/usr/bin/python3` として使われています。今回の検証環境ではバージョンが揃っているため差分は生じませんが、管理対象ノードのPythonバージョンが異なる環境では以下のような影響が出ることがあります。

|差分の種類|影響の例|
|---|---|
|Pythonのメジャーバージョン差分|モジュールが依存する標準ライブラリのAPIが異なる場合がある|
|文字列エンコーディングの扱い|Python 2とPython 3ではstr型の扱いが異なり、モジュールの出力処理に影響する場合がある|
|標準ライブラリのバージョン差分|同じメジャーバージョンでもマイナーバージョンによってライブラリの動作が異なる場合がある|

現在のAnsible core 2.15以降はPython 2のサポートを終了しており、リモートノードにPython 3が必要です。ただし、Python 3の中でもマイナーバージョンの差分はモジュールの内部処理に影響しうる要素として残っています。

セクション3で確認したとおり、`ansible_python` の情報はgather_factsで取得できます。複数ノードを管理する環境でPythonのバージョンが揃っているかどうかは、この情報で確認できます。

---

[↑ 目次に戻る](#-目次)

---

## 6. 冪等性は実行環境込みで成立する

セクション2〜5で確認した内容を構造として整理します。

第4回では、`state: latest` やバージョン未固定の指定によって、desired stateがパッケージリポジトリという外部要素に依存する問題を取り上げました。そのときの結論は「冪等性はPlaybook単体では閉じない」でした。

第7回で確認したのはさらにその手前の問題です。Playbookの記述そのものが「抽象命令」であり、その命令を実現するために何が実行されるかを実行環境が決めているという構造です。

セクション2〜5で見てきた内容を整理すると以下のようになります。

|セクション|確認した内容|実行環境への依存|
|---|---|---|
|2|`service` / `package` モジュールが内部で呼び出すコマンドはOSによって変わる|サービスマネージャー・パッケージマネージャーの種類|
|3|gather_factsで収集した環境情報がモジュールの内部処理の分岐条件になっている|OS種別・バージョン・Pythonパス|
|4|localeの設定によってコマンド出力の言語が変わりうる（現在のAnsibleではデフォルトで排除されている）|リモートノードのlocale設定|
|5|モジュールはリモートノードのPythonで動作するため、Pythonのバージョン差分が内部処理に影響しうる|リモートノードのPythonバージョン|

これらはいずれもPlaybookの記述の外にある要素です。Playbookに `service: name: nginx state: started` と書いても、その命令を実現するために `systemctl` が呼ばれるのか別のコマンドが呼ばれるのかは、リモートノードの環境が決めます。モジュールの差分検出ロジックもgather_factsで収集した環境情報に依存しています。

第4回の「外部要素」はパッケージリポジトリの状態でした。第7回の「外部要素」は実行環境そのものです。冪等性の成立条件に含まれる外部要素の範囲は、リポジトリの状態にとどまらず、OS・サービスマネージャー・パッケージマネージャー・Pythonバージョン・localeといった実行環境全体に及んでいます。

冪等性はPlaybookの記述だけで成立するものではありません。実行環境が安定していること、すなわち同じPlaybookを実行する環境が同じ構成を持っていることが前提になります。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

- **Playbookの記述はモジュールへの抽象命令である**。`service: name: nginx state: started` と書いても、モジュールが内部で呼び出すコマンドはリモートノードの環境によって変わる。「同じモジュール名を書く」ことと「同じコマンドが実行される」ことは別である。
- **gather_factsで収集した環境情報がモジュールの内部処理の分岐条件になっている**。OS種別・サービスマネージャー・パッケージマネージャー・Pythonのパスといった情報が、モジュールが内部で何を呼び出すかを決める判断材料として使われている。
- **localeの設定はモジュールの判定に直接影響しない**。現在のAnsibleはモジュール実行時にリモートノードのlocale設定に関わらず内部的に `LANG=C` を強制する（`module_set_locale` のデフォルトが `False`）。ただしこの保護が効かない構成も存在する。
- **モジュールはリモートノードのPythonで動作する**。Pythonのバージョン差分や標準ライブラリの差分が、モジュールの内部処理に影響しうる。複数ノードを管理する環境ではPythonのバージョンが揃っているかどうかをgather_factsで確認できる。
- **冪等性の成立条件に実行環境の安定性が含まれる**。第4回で確認したパッケージリポジトリの状態に加え、OS・サービスマネージャー・パッケージマネージャー・Pythonバージョンといった実行環境そのものも、冪等性の成立に関わる外部要素である。

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

今回は、Playbookの記述が「抽象命令」であり、モジュールが内部で呼び出すコマンドや処理は実行環境によって変わるという構造を確認しました。冪等性の成立条件には、Playbookの記述だけでなく実行環境の安定性も含まれます。

次回はさらに別の問題に進みます。実行環境が安定していても、タスク間の依存関係そのものが冪等性を壊すケースです。

**[次回：第8回：なぜタスクの依存関係は冪等性を壊すのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/)**

`handler` や `register` を使った条件分岐、タスクの実行順序によって、「前回の実行結果」に依存したPlaybookが生まれることがあります。この場合、同じPlaybookを実行しても、直前の実行状態によって結果が変わります。第7回が「環境が状態判定を揺らす」であれば、第8回は「タスク間の依存が状態遷移を揺らす」を扱います。

---

📑 連載の移動　**[前の記事：【冪等性編】 第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/)　｜　[次の記事：【冪等性編】 第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/)**

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