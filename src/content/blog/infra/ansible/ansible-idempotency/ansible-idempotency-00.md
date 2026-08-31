---
title: '「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第0回：冪等性とは何か、なぜ重要なのか'
description: 'Ansibleは冪等だから何回実行しても大丈夫は本当か。冪等性の本来の意味と「状態が収束する」ことの違いを、ShellとAnsibleの設計思想の差から整理する。'
pubDate: '2026-07-26'
category: 'infra'
tags: ['Ansible', '冪等性', 'idempotency', '構成管理', 'desired state']
seriesId: 'ansible-idempotency'
seriesNo: 0
prevPost: 'https://qiita.com/juehara-crypto/items/90977816de5c6a84d280'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/'
relatedSeries: ''
---


> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **[「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 シリーズまとめブログ](https://qiita.com/juehara-crypto/items/d77fa93e82ea4a33ef4f)**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [Ansibleは「コマンド実行ツール」ではない](#2-ansibleはコマンド実行ツールではない)
3. [そもそも「冪等性」とは何か](#3-そもそも冪等性とは何か)
4. [なぜAnsibleで冪等性が重要なのか](#4-なぜansibleで冪等性が重要なのか)
5. [「何度実行しても同じ結果」の本当の意味](#5-何度実行しても同じ結果の本当の意味)
6. [ShellスクリプトとAnsibleは何が違うのか](#6-shellスクリプトとansibleは何が違うのか)
7. [冪等性とは「状態遷移制御」である](#7-冪等性とは状態遷移制御である)
8. [なぜ冪等性は簡単に崩れるのか](#8-なぜ冪等性は簡単に崩れるのか)
9. [「changed=0」が意味するもの](#9-changed0が意味するもの)
10. [このシリーズで扱うこと](#10-このシリーズで扱うこと)
11. [まとめ](#11-まとめ)
12. [連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 ](#12-連載一覧ansibleは本当に冪等なのか冪等性が崩れる構造と設計 )

---


## 1. はじめに

「Ansibleは冪等だから何回実行しても大丈夫」という話を聞いたことがあると思います。

Ansibleを使い始めると、まずこの言葉に出会います。そして実際、多くの場面ではその通りに動いてくれます。`yum`でパッケージを入れれば、2回目以降は何も変更しない。`file`でディレクトリを作っても、すでにあれば手を出さない。こうした動きを見ていると「なるほど冪等だ」と感じます。

しかし実務で使い続けていると、そうでないケースにぶつかります。

- 毎回 `changed` になるタスクがある
- サービスが毎回 restart される
- `lineinfile` を使ったら同じ行が何度も追加された
- 環境によって挙動が変わる

こうした問題に共通しているのは、「Ansibleが冪等である」という前提への誤解です。

正確に言うと、**Ansibleというツールが冪等なのではなく、冪等になるよう設計されたモジュールが存在する**というのが実態です。設計次第でいくらでも冪等性は崩れます。

このシリーズでは、その「崩れる構造」を具体的に掘り下げていきます。第0回は、そのための土台として「冪等性とは何か」「なぜ重要なのか」を整理します。

---

[↑ 目次に戻る](#-目次)

---


## 2. Ansibleは「コマンド実行ツール」ではない

まず、Ansibleの立ち位置を確認しておきます。

Ansibleを「SSHでコマンドを自動実行するツール」として使っている場合、冪等性の問題がもっとも起きやすくなります。これは使い方として間違いではありませんが、Ansibleの設計思想とはずれています。

ShellとAnsibleの考え方の違いを整理すると以下のようになります。

|観点|Shell|Ansible|
|---|---|---|
|基本思想|手続き実行|状態管理|
|見ているもの|コマンドの結果|目標とする状態（desired state）|
|成功の判定|終了コード（rc）|状態が収束したかどうか|

Shellは「このコマンドを実行しろ」という指示を順番に処理します。一方Ansibleは「この状態にしろ」という宣言を受け取り、現在の状態と比較した上で必要な操作だけを行います。

つまりAnsibleは、本来「状態」を扱おうとしているツールです。この前提を理解した上で使うかどうかで、冪等性への向き合い方が変わります。

---

[↑ 目次に戻る](#-目次)

---



## 3. そもそも「冪等性」とは何か

冪等性（idempotency）はもともと数学の用語で、「同じ操作を何度繰り返しても結果が変わらない」性質を指します。

わかりやすい例を挙げます。

- `mkdir /tmp/work` は、ディレクトリがすでに存在するとエラーになります。**非冪等**です。
- `mkdir -p /tmp/work` は、すでに存在していても問題なく終了します。**冪等的**です。

HTTP メソッドで言えば、PUT は同じリクエストを何度送っても結果が同じになるよう設計されています。POST はそうではありません。データベースのマイグレーションも、「適用済みかどうかを確認してから実行する」仕組みが冪等性を実現しています。

構成管理の文脈で言うと、冪等性とは「同じ操作を繰り返しても、状態が変化し続けない」ことを指します。

1回目の実行で状態が変わる。2回目以降は何も変わらない。これが冪等です。

---

[↑ 目次に戻る](#-目次)

---



## 4. なぜAnsibleで冪等性が重要なのか

「冪等かどうか」がなぜ問題になるのか、実害を具体的に見ておきます。

**サービスが毎回 restart される**

`notify` でハンドラを呼び出す構成にしている場合、`changed` が発生するたびにサービスが再起動します。実際には設定ファイルが変わっていないのに `changed` が出続けると、不要な restart が毎回走ります。

**CI/CD で差分が止まらない**

自動化パイプラインで Playbook を定期実行している場合、冪等でないタスクがあると毎回 `changed` が記録されます。「変更があった」という通知が毎回飛んで、本当に必要な変更と区別がつかなくなります。

**手動での確認が増える**

冪等性が信頼できないと、実行前に「今の状態はどうなっているか」を手動で確認する必要が出てきます。自動化している意味が薄れていきます。

**再実行できない**

障害対応やデプロイのやり直しで Playbook を再実行した際、冪等でないタスクが副作用を起こすことがあります。再実行が怖くてできない、という状況は自動化の価値を大きく下げます。

冪等性は、自動化を「安心して使えるもの」にするための基盤です。

---

[↑ 目次に戻る](#-目次)

---


## 5. 「何度実行しても同じ結果」の本当の意味

「冪等 = 何度実行しても成功する」と理解している場合、少し認識を修正する必要があります。

以下のタスクを見てください。

```yaml
- name: nginx を再起動する
  ansible.builtin.shell: systemctl restart nginx
```

このタスクは何度実行しても成功します（nginx が動いている限り）。しかし**冪等ではありません**。

なぜかというと、毎回 nginx を再起動するという「変化」が起きているからです。アクセスが切断されるかもしれない。ログにエラーが残るかもしれない。1回目の実行と2回目の実行で、システムの状態として「同じ」とは言えません。

冪等性の本質は「成功すること」ではなく、**「状態が収束すること」** です。

- 1回目：目標の状態と差分があるので変更を加える（changed）
- 2回目以降：すでに目標の状態になっているので何もしない（ok）

この「2回目以降は何もしない」という動きが冪等性の実体です。成功と冪等は別の話です。

---

[↑ 目次に戻る](#-目次)

---


## 6. ShellスクリプトとAnsibleは何が違うのか

同じことをShellとAnsibleで書いた場合の違いを見てみます。

**Shellの場合**

```bash
useradd ansible_user
```

このコマンドはユーザーが存在しない場合は成功しますが、すでに存在する場合はエラーになります。「ユーザーを作れ」という手続きの指示です。

**Ansibleの場合**

```yaml
- name: ansible_user を作成する
  ansible.builtin.user:
    name: ansible_user
    state: present
```

このタスクはユーザーが存在しなければ作成し、すでに存在していれば何もしません。「ansible_user が存在している状態にしろ」という状態の宣言です。

この違いが、imperative（手続き型）と declarative（宣言型）の差です。

Shellは「何をするか」を記述します。Ansibleは（本来）「どういう状態であるべきか」を記述します。宣言型の書き方をすることで、差分比較と冪等な実行が可能になります。

ただしAnsibleには `shell` モジュールや `command` モジュールがあり、Shellのコマンドをそのまま実行することもできます。このモジュールを使う場合は、Ansible上でShellを書いているのと実質変わりません。冪等性はモジュールの設計に依存しています。

---

[↑ 目次に戻る](#-目次)

---



## 7. 冪等性とは「状態遷移制御」である

ここで一段抽象化して整理します。

Ansibleのモジュールが冪等に動く場合、内部では以下の処理が行われています。

```
現在の状態を観測する
    ↓
目標の状態（desired state）と比較する
    ↓
差分がある場合のみ変更を加える
```

`file` モジュールでパーミッションを設定する場合、現在のパーミッションを確認して、目標と一致していれば何もしません。`yum` でパッケージを入れる場合も、インストール済みであれば変更しません。

つまり冪等なモジュールは、「変更する能力」だけでなく **「変更しない能力」** を持っています。

現在状態 → 観測 → 差分検出 → 必要な場合のみ変更 → 目標状態へ収束

この「状態遷移を制御する」という構造が、冪等性の実体です。逆に言えば、現在の状態を確認せずにコマンドを実行するだけの処理は、状態遷移を制御できていないため冪等になりません。

---

[↑ 目次に戻る](#-目次)

---



## 8. なぜ冪等性は簡単に崩れるのか

Ansibleで冪等性が崩れるパターンは複数あります。第1回以降で個別に掘り下げますが、ここでは概要を整理しておきます。

**shell/command モジュールの使用**

現在の状態を観測する仕組みがありません。毎回コマンドを実行するため、`changed` が出続けます。

**`state: latest` の使用**

「常に最新バージョン」という指定は、パッケージの新バージョンが出るたびに `changed` になります。desired state が「今この瞬間の最新版」であり、固定されていません。

**lineinfile の使い方**

設定ファイルに行を追加する際、マッチ条件が不適切だと同じ行が複数回挿入されることがあります。

**handler の連鎖**

ファイルの変更を検知してサービスを再起動する構成で、毎回 `changed` が発生していると毎回再起動が走ります。

**環境差分**

OS のバージョンや Python のバージョン、locale の違いによって、同じモジュールが異なる動きをすることがあります。

これらに共通しているのは、「Ansibleが自動で冪等にしてくれるわけではない」という点です。冪等性はモジュール選択と設計によって実現するものです。

---

[↑ 目次に戻る](#-目次)

---



## 9. 「changed=0」が意味するもの

Ansible の実行結果には `changed` というカウントが表示されます。

```
PLAY RECAP
server01 : ok=5  changed=2  unreachable=0  failed=0
```

`changed` は「変更が発生したタスクの数」です。`changed=0` は「どのタスクも変更を加えなかった」ことを意味します。

重要なのは、これは「成功した」という意味ではないということです。正確には「現在の状態がすでに目標の状態と一致していたため、変更の必要がなかった」という意味です。

実務でよく使われる確認方法として、「同じ Playbook を2回実行して、2回目が `changed=0` になるかどうか」があります。これが冪等性の最も直接的なチェックです。

1回目の実行で目標状態にする。2回目の実行で `changed=0` になる。この状態が「冪等に設計されている」と言えます。

`changed=0` になるかどうかは、Playbook を本番環境で安心して使えるかどうかの一つの基準になります。

---

[↑ 目次に戻る](#-目次)

---



## 10. このシリーズで扱うこと

このシリーズでは、冪等性が崩れる具体的なパターンを一つずつ取り上げます。

|回|テーマ|扱う内容|
|---|---|---|
|**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)**|shell/command モジュール|なぜ状態を持てないのか|
|**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-02/)**|file/copy/template|なぜ差分比較ができるのか|
|**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)**|ファイル操作|見えない差分が changed を起こす仕組み|
|**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/)**|パッケージ管理|`state: latest` が冪等性を壊す理由|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-05/)**|サービス制御|handler 連鎖と再起動ループ|
|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/)**|lineinfile|なぜ「安全そうに見えて危険」なのか|
|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-07/)**|環境差分|同じ Playbook が環境ごとに異なる動きをする理由|
|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/)**|タスクの依存関係|実行順序と条件分岐が冪等性を崩す構造|
|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-09/)**|検証方法|冪等性をどう確認するか|
|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-10/)**|設計の考え方|冪等に設計するとはどういうことか|

各回は「なぜそうなるのか」という構造の説明を軸にしています。トラブルの対処法だけでなく、発生する仕組みを理解することで、同種の問題に応用できるようにしていきます。

---

[↑ 目次に戻る](#-目次)

---



## 11. まとめ

この回で整理した内容を確認します。

- **Ansibleは状態管理ツールである**。コマンド実行を自動化するツールとして使うと、冪等性の問題が起きやすい。
- **冪等性とは「状態が収束すること」** であり、「成功すること」ではない。
- **冪等なモジュールは現在の状態を観測し、差分がある場合のみ変更する**。この「変更しない能力」が冪等性の実体である。
- **Ansibleが自動で冪等にしてくれるわけではない**。モジュールの選択と設計によって冪等性は実現される。
- **2回目の実行で `changed=0` になるか**が、冪等性を確認する最も直接的な方法である。

冪等性を意識して設計された Playbook は、何度実行しても安全で、再実行を恐れずに済みます。このシリーズでは、その設計の考え方を「崩れる構造から学ぶ」というアプローチで整理していきます。

---

📑 連載の移動 **前の記事：[【Ansible編】第10回](https://qiita.com/juehara-crypto/items/90977816de5c6a84d280) ｜ [次の記事：【冪等性編】 第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **[「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 シリーズまとめブログ](https://qiita.com/juehara-crypto/items/d77fa93e82ea4a33ef4f)**

---

[↑ 目次に戻る](#-目次)

---


## 12. 連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 

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
