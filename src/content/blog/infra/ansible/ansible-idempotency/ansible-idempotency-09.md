---
title: '「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 第9回：冪等性はどうやって検証すべきなのか'
description: 'check mode の限界、diff mode、molecule、CI、自動テストを通して、「2回目 changed=0」をどう保証するのかを理解する。'
pubDate: '2026-07-29'
category: 'infra'
tags: ['Ansible', '冪等性', 'idempotency', '--check', '--diff', 'Molecule', 'CI']
seriesId: 'ansible-idempotency'
seriesNo: 9
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-10/'
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
2. [「2回実行してchanged=0になること」は何を意味するのか](#2-2回実行してchanged0になることは何を意味するのか)
3. [`--check` モードの限界](#3---check-モードの限界)
4. [`--diff` モードの用途と限界](#4---diff-モードの用途と限界)
5. [Moleculeによる自動テスト](#5-moleculeによる自動テスト)
6. [CIとの統合による継続的な保証](#6-ciとの統合による継続的な保証)
7. [「冪等性が保証された」と言えるのはどういう状態か](#7-冪等性が保証されたと言えるのはどういう状態か)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜](#10-連載一覧ansibleは本当に冪等なのか冪等性が崩れる構造と設計)


---

## 1. はじめに

**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/)** では、`register` / `when` / `handler` の組み合わせによってPlaybookが実行履歴に依存した構造になり、状態遷移が閉じなくなる問題を確認しました。冪等性とは「同じタスクを書くこと」ではなく「状態遷移を閉じること」であり、その設計はPlaybookが複雑化するほど難しくなります。

今回はその先に進みます。「状態遷移が壊れやすいことは分かった、では壊れていないことをどう確認するか」という問いです。

冪等性を確認したいとき、まず思い浮かぶのは `--check` モードか、同じPlaybookを2回実行することではないでしょうか。しかし「`--check` で問題が出なかった」「2回目が `changed=0` になった」という確認で、「冪等性が保証された」と言えるのでしょうか。

この回では、`--check` / `--diff` モードの動作と限界、Moleculeによる自動テスト、CIとの統合という順に整理します。検証ツールや手法の紹介にとどまらず、「その確認で何が言えて、何が言えないか」を軸に置きます。


---

[↑ 目次に戻る](#-目次)

---

## 2. 「2回実行してchanged=0になること」は何を意味するのか

冪等性の確認として最もシンプルで、かつ実態に近い方法は「同じPlaybookを2回実行し、2回目が `changed=0` になること」を確認することです。

2回目が `changed=0` になることが確認できれば、「そのPlaybookが、少なくともその実行時点において同じ状態への収束をもたらす」ことを実際の動作として確認したことになります。`--check` モードが「変更が必要かどうか」をモジュールに問い合わせる間接的な確認であるのに対し、2回実行は実際にリモートノードの状態を変化させた上で確認しているため、より実態に近い結果が得られます。

ただし、この確認だけでは不十分なケースがあります。

**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/)** で扱った `state: latest` のような外部状態に依存するケースがその一つです。2回連続で実行している間はリポジトリが更新されていないため `changed=0` になりますが、時間を置いた再実行ではリポジトリ側に新しいバージョンが追加されていることがあります。「連続2回の実行で確認した」という事実は、外部状態が変化した後の動作を保証しません。

**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/)** で扱った `register` / `when` の組み合わせが絡む場合も同様です。1回目が正常完了した後の2回目と、1回目が途中で失敗した後の再実行では、`register` 変数の状態が異なるため別の経路をたどる場合があります。「正常完了後の2回目が `changed=0`」という確認は、失敗からの再実行で同じ経路をたどることを保証していません。

「2回実行して `changed=0`」という確認は冪等性の確認として有効です。ただし、その確認が成立する前提として「外部状態が安定していること」と「実行経路が1種類に限られること」があります。この2つの前提が崩れるケースでは、追加の確認が必要になります。


---

[↑ 目次に戻る](#-目次)

---

## 3. `--check` モードの限界

`--check` モードはリモートノードへの変更を実際には加えずに、「変更が必要かどうか」を確認するモードです。ドライランとも呼ばれ、本番実行前の事前確認として使われることが多いです。

```plaintext
ansible-playbook -i inventory.ini site.yml --check
```

このモードの動作を実機で確認します。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** で使用したshellモジュールのPlaybookを `--check` で実行してみます。

---

#### ■ 検証内容（`--check` モードの動作確認）

**ファイル名: `test_shell_changed.yml`**

```yaml
---
- name: shellモジュールの changed 動作確認
  hosts: test_servers
  gather_facts: false

  tasks:
    - name: ディレクトリを作成する（shell）
      ansible.builtin.shell: mkdir -p /tmp/sample_shell
```

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini test_shell_changed.yml --check
```

**▼ 実行結果**

```plaintext
PLAY [shellモジュールの changed 動作確認] ***************************************************************************************************************************************************

TASK [ディレクトリを作成する（shell）] ******************************************************************************************************************************************************
skipping: [192.168.1.22]
skipping: [192.168.1.21]

PLAY RECAP **********************************************************************************************************************************************************************************
192.168.1.21               : ok=0    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
192.168.1.22               : ok=0    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
```

#### ■ 結果

`shell` モジュールのタスクは `--check` 時に `skipping` と表示され、PLAY RECAPでは `skipped=1` として集計されました。`shell` / `command` モジュールはデフォルトで `--check` 時にスキップされます。実行結果は `changed=0` と表示されていますが、これは「差分がなかった」という意味ではなく「タスクが実行されなかった」という意味です。

**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** で確認したとおり、このPlaybookを通常実行すると毎回 `changed=1` になります。`--check` ではその非冪等性を検出できていません。

---

`--check` モードには他にも動作上の制約があります。

**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/)** で扱った `register` / `when` の構成では、`--check` 時の動作が通常実行と異なる場合があります。`--check` モードでは実際の変更が加えられないため、あるタスクが「差分なし」と判定された場合、そのタスクの `register` 変数の `changed` フィールドが `false` になります。後続タスクが `when: some_task.changed` を参照している場合、`--check` 時は「差分なし→`when` 条件が `false`→後続タスクをスキップ」という経路をたどります。しかし実際の実行では差分があるケースでは、`--check` が示した経路と実際の経路が食い違います。`register` / `when` の組み合わせが増えるほど、`--check` での確認結果と実行結果のずれが生じやすくなります。

また `--check` が確認しているのは「モジュールが現時点で差分を検出するかどうか」です。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)** で扱ったchecksum差分の問題や、第6回で扱った `lineinfile` の挙動は、`--check` 実行時にもモジュールの差分検出ロジックに従って判定されます。`--check` がその判定の正確さを保証するわけではありません。

`--check` モードは「このPlaybookを今実行したら変更が発生しそうか」という手がかりを得るためには有効です。しかし「問題がない」という確認にはなりません。shellモジュールの非冪等性は検出されず、`register` / `when` の構成では実際の実行経路と食い違う場合があります。`--check` で問題が出なかったことは、冪等性が保証されたことを意味しません。

---

[↑ 目次に戻る](#-目次)

---

## 4. `--diff` モードの用途と限界

`--diff` モードは `template` / `copy` / `file` モジュールが `changed=1` になったとき、変更前後のファイル差分を表示するモードです。

```plaintext
ansible-playbook -i inventory.ini site.yml --diff
```


`--check` と組み合わせることで、実際の変更を加えずに「何が変わるか」を確認できます。

```plaintext
ansible-playbook -i inventory.ini site.yml --check --diff
```


**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-02/)** で確認したとおり、`template` モジュールはレンダリング後の出力のchecksumを転送先ファイルと比較して差分を検出します。`--diff` はその差分の内容を実行前に可視化できるため、「意図した変更が加わるかどうか」を人間が確認する手段として有用です。

ただし `--diff` にも限界があります。

`shell` / `command` モジュールには差分表示が機能しません。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)** で取り上げたchecksum差分はファイルの内容に関するものですが、shellモジュールが実行するコマンドの副作用は `--diff` では表示されません。

また `--diff` が行うのは差分の表示だけです。「その差分が意図通りかどうか」は人間が判断する必要があります。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)** で扱ったJinja2のwhitespace差分のように、差分が表示されても「なぜこの差分が出るのか」を読み解くのは容易でない場合があります。

`--check` と組み合わせた場合は、`--check` の限界をそのまま引き継ぎます。`shell` モジュールのタスクはスキップされ、`register` / `when` の構成では実際の実行経路と食い違う場合があります。

`--diff` は「変更を加える前に何が変わるかを確認する」という用途には有効です。しかし表示された差分が意図通りかどうかの判断は人間に委ねられており、冪等性の保証にはなりません。

---

[↑ 目次に戻る](#-目次)

---

## 5. Moleculeによる自動テスト

Moleculeは独立した環境（DockerコンテナやVMなど）でPlaybookを実行し、テストを自動化するフレームワークです。セクション2で整理した「2回実行して `changed=0` になること」という確認を、自動的に実行する仕組みを提供します。

Moleculeが実行するシナリオの基本的な流れは以下のとおりです。

1. **create**：テスト用の環境を準備する（Dockerコンテナの起動など）
2. **converge**：対象のPlaybookを適用する
3. **idempotency check**：同じPlaybookをもう一度実行し、`changed` が発生した場合にテスト失敗とする
4. **destroy**：テスト用の環境を破棄する

Moleculeを使うことで確認内容が変わるわけではありません。「2回実行して2回目が `changed=0` になること」という確認の中身はセクション2で整理したものと同じです。Moleculeはその確認を、独立した環境で毎回・自動で実行できるようにする仕組みです。

手動で2回実行する場合との違いは2点あります。1点目は、テスト用の環境が毎回クリーンな状態から始まるため、前回の実行結果が残った状態での確認にならないことです。2点目は、確認の手順が自動化されているため、Playbookに変更を加えるたびに同じ手順で確認を繰り返せることです。

セクション2で確認した「2回実行による `changed=0`」の限界はMoleculeでも引き継ぎます。外部状態に依存するケースや、実行経路が複数ある構成での確認範囲は変わりません。

Moleculeの詳細なインストール方法や設定方法はこの回の主題ではありません。公式ドキュメントを参照してください。

- [Molecule documentation](https://ansible.readthedocs.io/projects/molecule/)

---

[↑ 目次に戻る](#-目次)

---

## 6. CIとの統合による継続的な保証

セクション5で整理したMoleculeによる自動テストは、単体で実行しても有用です。しかし手動でMoleculeを実行する運用では、「Playbookに変更を加えたときに確認を忘れる」「一度確認した後の変更で冪等性が崩れても気づけない」という問題が残ります。

CIにMoleculeを組み込むことで、この問題に対処できます。GitHub ActionsなどのCIサービスでは、リポジトリへのpushやpull requestをトリガーとしてMoleculeを自動実行する構成を作れます。

CI統合の基本的な流れは以下のとおりです。

1. Playbookリポジトリへのpushまたはpull requestが発生する
2. CIがMoleculeを起動する
3. Moleculeがクリーンな環境でPlaybookを2回実行し、2回目に `changed` が発生した場合にCIが失敗する
4. CIが失敗した場合、その変更はマージされない

この構成によって「一度確認した」が「変更のたびに確認し続ける」に変わります。Playbookへの変更が冪等性を壊していないことを、マージ前に自動で確認できます。

なぜCIが必要かという問いに対する答えは、冪等性の崩れ方の構造にあります。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-03/)** で扱ったJinja2のwhitespace差分、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/)** で扱った `lineinfile` の挙動、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/)** で扱った `register` / `when` の組み合わせによる実行経路の分岐は、いずれもPlaybookの一部を変更したときに意図せず生じることがあります。変更のたびに手動で確認する運用は現実的でなく、確認漏れが生まれます。CIによる自動実行は、その確認漏れを構造的に防ぐ手段です。

ただし、CIが確認できる範囲はMoleculeの確認範囲と同じです。「変更のたびに確認し続ける」仕組みが加わっても、外部状態依存のケースや複数の実行経路を持つ構成への対応は変わりません。

GitHub Actionsへの具体的な組み込み方法はこの回の主題ではないため、概念の説明にとどめます。


---

[↑ 目次に戻る](#-目次)

---

## 7. 「冪等性が保証された」と言えるのはどういう状態か

セクション2〜6で整理した各手段を振り返ります。

|手段|確認できること|確認できないこと|
|---|---|---|
|`--check`|モジュールが差分を検出するかどうか|shellモジュールの非冪等性、`register` / `when` のずれ|
|`--diff`|変更前後のファイル差分の内容|差分が意図通りかどうかの判定|
|2回実行で `changed=0`|その時点での同じ状態への収束|外部状態変化後の動作、別実行経路での動作|
|Molecule + CI|変更のたびに上記の確認を自動実行|各手段そのものの限界は引き継ぐ|

「冪等性が保証された」という言葉は、「何を確認したか」と「どの前提条件のもとで」という2つがセットになって初めて意味を持ちます。

`--check` で問題が出なかったことは、shellモジュールの非冪等性を検出できていない可能性があります。2回実行で `changed=0` になったことは、外部状態が変化した後や別の実行経路では同じ結果にならない可能性があります。Molecule + CIを導入しても、確認内容の限界は各手段から引き継ぎます。

確認できる範囲を広げることはできます。`--check` だけより2回実行のほうが実態に近く、手動確認よりMolecule + CIのほうが変更のたびに確認を継続できます。しかしすべての実行経路と外部状態の組み合わせを網羅することは現実的ではありません。

「冪等性が保証された」と言えるのは、「どの手段で」「どの前提条件のもとで」「何を確認したか」を明示した上でのことです。その範囲を明示せずに「保証された」と言うことは、確認していない部分を保証しているように見せることになります。どの範囲で何を確認したかを明示することが、冪等性の「保証」という言葉に対して正確な態度です。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

- **冪等性の確認として最も実態に近いのは「2回実行して `changed=0` になること」である**。`--check` モードよりも実際の動作に基づいた確認だが、外部状態に依存するケースや複数の実行経路を持つ構成では、この確認だけでは不十分な場合がある。

- **`--check` モードはドライランだが、確認できる範囲に限界がある**。`shell` / `command` モジュールはデフォルトでスキップされるため非冪等性を検出できない。`register` / `when` の構成では実際の実行経路と食い違う場合がある。`--check` で問題が出なかったことは、冪等性が保証されたことを意味しない。

- **`--diff` モードは変更前後のファイル差分を表示するが、冪等性の保証にはならない**。差分の内容を可視化できるが、それが意図通りかどうかの判断は人間が行う必要がある。`shell` / `command` モジュールには差分表示が機能しない。`--check` と組み合わせた場合は `--check` の限界を引き継ぐ。

- **Moleculeは「2回実行して `changed=0`」という確認を自動化する仕組みである**。独立したクリーンな環境でPlaybookを2回実行し、2回目に `changed` が発生した場合にテスト失敗とする。確認内容が変わるわけではなく、その確認を毎回・自動で実行できるようになる。

- **CIにMoleculeを組み込むことで「一度確認した」を「変更のたびに確認し続ける」に変えられる**。Playbookへの変更が冪等性を壊していないことをマージ前に自動で確認できる。ただし各手段そのものの限界は引き継ぐ。

- **「冪等性が保証された」は「何を確認したか」と「どの前提条件のもとで」がセットになって初めて意味を持つ**。確認できる範囲を広げることはできるが、すべての実行経路と外部状態を網羅することは現実的ではない。どの範囲で何を確認したかを明示することが、冪等性の「保証」という言葉に対して正確な態度である。

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

今回は、冪等性の確認手段とその限界を整理しました。`--check` / `--diff` モードが何を確認し何を確認できないか、「2回実行して `changed=0`」という確認がどの前提条件のもとで成立するか、MoleculeとCIがその確認を自動化・継続化する仕組みであることを見てきました。

次回はその先に進みます。「壊れていないことを確認する」ではなく「そもそも壊れない設計をする」という問いです。

**[次回：第10回：「冪等に設計する」とは何を設計することなのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-10/)**

第1回から第9回まで、冪等性が崩れる構造と、崩れていないことを確認する手段を見てきました。shellモジュールの設計上の限界、差分検出が壊れるパターン、desired stateが外部に委譲される問題、`notify` による状態遷移の連鎖、`lineinfile` の管理粒度、実行環境の差分、タスク依存による実行履歴依存の構造、そして検証手段の限界。これらは「壊れる理由」と「壊れていることを発見する方法」の話でした。

第10回は「壊れない設計をする」という問いへの答えを整理します。手続き的なワークフローではなく状態宣言としてPlaybookを設計するとはどういうことか、desired stateをPlaybook内で閉じるとはどういうことか、シリーズ全体の結論として着地します。

---

📑 連載の移動　**[前の記事：【冪等性編】 第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-08/)　｜　[次の記事：【冪等性編】 第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-10/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **[「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 シリーズまとめブログ](https://qiita.com/juehara-crypto/items/d77fa93e82ea4a33ef4f)**

---

[↑ 目次に戻る](#-目次)

---


## 10. 連載一覧：「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜 


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
