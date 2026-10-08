---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第8回：GitOpsの品質ガードレールとしてMoleculeとansible-lintを組み込む'
description: 'ansible-lintとMoleculeを、テストの設定としてではなく、チェックを通らなかった変更をインフラに届かせないガードレールとして、GitOpsのパイプラインに組み込む。ansible-lintが承認の材料に現れないタスクを、Moleculeが収束しないPlaybookを止めることを整理し、承認ゲートの入口でチェックの結果を確かめる構成を作る。あわせて、`changed_when: false`のように表示を変えるだけの書き方で、ガードレールをすり抜けられる限界を示す。'
pubDate: 2026-10-09
category: 'infra'
tags: ['Ansible', 'GitOps', 'GitHub Actions', 'ansible-lint', 'Molecule']
seriesId: 'ansible-gitops-part2'
seriesNo: 8
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>


> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第2部まとめブログ：GitOpsパイプラインで「見たものだけが、承認したときだけ届く」仕組みを積み上げる** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [ガードレールは何を止めるのか](#2-ガードレールは何を止めるのか)
3. [ansible-lintで承認の材料から漏れるタスクを見つける](#3-ansible-lintで承認の材料から漏れるタスクを見つける)
4. [Moleculeの冪等性テストと自動収束](#4-moleculeの冪等性テストと自動収束)
5. [ガードレールはすり抜けられる](#5-ガードレールはすり抜けられる)
6. [パス判定でチェックを絞り込む](#6-パス判定でチェックを絞り込む)
7. [適用前にチェック結果を確認する](#7-適用前にチェック結果を確認する)
8. [self-hostedランナー上でMoleculeを動かす](#8-self-hostedランナー上でmoleculeを動かす)
9. [Moleculeが保証する範囲](#9-moleculeが保証する範囲)
10. [クラウドの操作対象でもガードレールは変わらない](#10-クラウドの操作対象でもガードレールは変わらない)
11. [まとめ](#11-まとめ)
12. [次回予告](#12-次回予告)
13. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#13-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

AnsibleのPlaybookをGitで管理し、プルリクエストでansible-lintとMoleculeのチェックを実行していて、

* プルリクエストのたびに、ansible-lintとMoleculeのチェックが動く
* チェックが失敗すれば、プルリクエストに失敗の印が付く
* よって、品質に問題のある変更は、インフラに届かない

と考えていないでしょうか。

ansible-lintやMoleculeを扱う記事の多くは、ルールの意味や、CIでチェックを実行する設定を中心にしています。チェックの結果が、どの仕組みによってマージや適用を止めるのかや、チェックを通り抜けてしまう書き方は、あまり扱われていません。チェックをパイプラインに組み込んで運用し始めると、次のような場面にぶつかります。

* プルリクエストのチェックが失敗しているのに、マージできてしまった
* チェックが失敗したままのコミットでも、適用のワークフローは止まらなかった
* ansible-lintの指摘に従って`changed_when`を付けたら、ansible-lintもMoleculeのテストも通ったが、実行のたびに設定は書き換わり続けていた
* Playbookと関係のない変更でも、時間のかかるMoleculeのテストが毎回動く
* Moleculeのテスト用のコンテナが、操作対象と同じホストに残り続けた

これらは、チェックの設定やルールの選び方の問題に見えます。共通しているのは、チェックを実行することと、チェックを通らなかった変更をインフラに届かせないことが、パイプラインの構造として結びついていない点です。そして、チェックが通ったことが、Playbookが冪等であることを意味するとは限らない点です。

Playbookの品質を確かめる手段は、**[「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜](https://qiita.com/juehara-crypto/items/d77fa93e82ea4a33ef4f)**（以下、冪等性シリーズ）と、**[「AnsibleのPlaybookが壊れる理由はテスト文化にあった」](https://qiita.com/juehara-crypto/items/194d5730466aef04ed44)**（以下、Moleculeシリーズ）で扱ってきました。冪等性シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** では、`shell`や`command`のモジュールは現在の状態を観測しないこと、`changed_when`は`changed`の表示を制御するだけで、`changed_when: false`を付けても状態は変わり続けることを確認しました。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/)** では、`state: latest`が、あるべき状態の定義をパッケージのリポジトリに委ねることを整理しました。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-10/)** では、`creates`や`stat`のように現在の状態を観測する条件を、`shell`の周囲に設計者が持ち込むパターンを示し、Ansibleが提供するのは冪等性を設計しやすい構造であって、冪等性の自動的な保証ではないと結論づけました。

Moleculeシリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-02/)** では、冪等でないタスクを加えると、Moleculeの冪等性テスト（idempotence）が失敗し、原因のタスクを出力から特定できることを確認しました。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-03/)** では、ansible-lintのルールを設計品質の静的な確認として位置づけ、`changed_when`のない`command`のタスクが`no-changed-when`のルールで検出されることを確認しました。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-04/)** では、ansible-lintとMoleculeを、プッシュやプルリクエストをきっかけに自動で実行し、「変更のたびに確認し続ける」仕組みにする考え方を整理しました。同じ回では、CIが失敗すればマージされないことで、問題のあるPlaybookの混入を防ぐ構造としています。これらの回は、Playbookの品質を確かめる手段そのものを扱ったもので、チェックの結果がどの仕組みでマージや適用を止めるのかや、チェックそのものがどこまで信用できるのかは扱っていません。

本シリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5では、この検証環境の非公開リポジトリでは、ブランチ保護のルールを作成しても強制されず、mainへの直接プッシュを止められないことを確認しました。そのうえで、強制する場所を「mainに入る前」から「インフラに適用する前」に移す方針を示しました。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** では、インベントリが空のままAnsibleが1台にも接続せずに終わっても、パイプラインが成功と表示されることを確認し、「成功と表示された」ことと「意図した対象に適用された」ことは別だと整理しました。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、適用系を手動で起動するワークフローに分け、その入口で、mainからの起動であること、承認待ちのplanを作ったコミットがmainの先頭と同じであること、起点からのコミットがすべてプルリクエストのマージであることを確かめる承認ゲートを組みました。同じ回では、`--check --diff`の出力を承認の材料にしても、`shell`のタスクは`skipping`と表示されるだけで、本実行で何が変わるかは承認する人に見えないことを確認しています。そして、入口で確かめているのはプルリクエストを通ったかどうかまでで、そのプルリクエストのチェックが成功したかは見ていないことを、残る限界として整理しました。

第8回となる今回は、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** で組んだ人の承認の手前に、機械的なチェックを置きます。ansible-lintとMoleculeを、テストの設定としてではなく、GitOpsのパイプラインの前提を守るガードレールとして位置づけます。まず、ansible-lintとMoleculeが、それぞれ何を止めるのかを整理します。ansible-lintは、承認の材料に現れないタスクや、あるべき状態をPlaybookの外に委ねるタスクを、実行の前に見つけます。Moleculeの冪等性テストは、第4部（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** 〜 **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**）の自動収束が成り立つための、何度実行しても収束するという前提を、マージの前に確かめます。次に、`changed_when: false`のように表示を変えるだけの書き方で、2つのチェックをすり抜けられることを実機で確認します。そのうえで、変更されたパスでチェックを絞り込み、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** の承認ゲートの入口にチェックの結果の確認を加えて、チェックを通っていないコミットを適用しない構成を作ります。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で適用の前に移すとした強制を、チェックの結果についても実装する回です。リポジトリの条件によって使える必須チェックの機能は、同じことを作る方法として併記します。最後に、self-hostedランナーの上でMoleculeを動かす際の注意と、Moleculeが保証する範囲を整理します。

正確に言うと、**ガードレールとは、チェックを実行することではなく、チェックを通らなかった変更がインフラに届かない構造のことであり、そのチェック自体も、通し方によってはすり抜けられます**。この回で扱う問いは、「チェックを通らなかった変更をインフラに届かせないには、何をどこに置けばよいのか。そして、そのチェックはどこまで信用できるのか」です。

次のセクションでは、2つのチェックが、それぞれGitOpsのどの前提を守るのかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. ガードレールは何を止めるのか

ansible-lintとMoleculeが止めるものを、GitOpsのパイプラインが置いている前提と対応づけて整理します。

### パイプラインが置いている2つの前提

ここまでの回で組んだパイプラインは、Playbookについて、次の2つを前提にしています。

* **承認の材料から、適用で何が変わるかを予測できる**：**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** の承認ゲートでは、承認する人が`--check --diff`の出力を見て、適用してよいかを判断します。この判断が成り立つのは、本実行で変わる内容が、確認モードの出力に現れている場合に限られます
* **何度実行しても、同じ状態に収束する**：**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション5では、作り直したリソースに、Playbookの全タスクを適用し直す必要があると整理しました。第4部では、Playbookを繰り返し実行して、ずれの検知と収束を行います。どちらも、収束した状態に対して実行すれば何も変わらないことを前提にしています

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4で確認したとおり、`shell`のタスクは、確認モードでは`skipping`と表示されるだけで、本実行では`changed`になりました。1つ目の前提は、Playbookの書き方によって崩れます。2つ目の前提も同じです。冪等性シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** で確認したとおり、現在の状態を観測しないタスクは、実行のたびに`changed`になります。

この回のガードレールは、この2つの前提が崩れた変更を、インフラに届く前に止めるためのものです。

### ansible-lintは「予測できる」を守る

ansible-lintは、Playbookを実行せずに、書かれた内容だけを見て判定します。Moleculeシリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-03/)** で確認したとおり、`changed_when`のない`command`のタスクは、`no-changed-when`のルールで検出されます。

1つ目の前提に照らすと、ansible-lintが見つけるのは、次のようなタスクです。

* 確認モードで内容が現れず、本実行で何が変わるかを承認する人が予測できないタスク（`changed_when`のない`command`や`shell`）
* あるべき状態の定義を、Playbookの外に委ねているタスク（`state: latest`）

`state: latest`は、Moleculeでは止められません。冪等性シリーズの **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/)** では、`state: latest`のタスクを続けて2回実行すると、リポジトリが変わらない限り、2回目は`changed=0`になることを確認しました。Moleculeの冪等性テストも、同じ時点で2回続けて実行して比べるため、この時点では通ります。問題が現れるのは、リポジトリが更新された後の実行です。テストの時点では収束していても、承認した時点と適用する時点で、何がインストールされるかが変わりえます。これを実行の前に見つけられるのは、書かれた内容を見る静的なチェックだけです。

ansible-lintが、`state: latest`をどのルールで、どう判定するかは、**[セクション3](#3-ansible-lintで承認の材料から漏れるタスクを見つける)** で、この検証環境のバージョンで確認します。

### Moleculeは「収束する」を守る

Moleculeは、Playbookを実際に実行して判定します。Moleculeシリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-02/)** で確認したとおり、冪等性テストは、同じPlaybookを続けて実行し、2回目に`changed`が出たタスクがあれば失敗とします。

2つ目の前提に照らすと、Moleculeが見つけるのは、収束しないPlaybookです。同じ回で確認したとおり、この失敗はAnsibleの実行エラーではなく、`ansible-playbook`自体は`failed=0`のまま終わります。パイプラインで本実行だけを見ていれば、成功として扱われる状態です。収束しないPlaybookが第4部の自動収束に載ったときに何が起きるかは、**[セクション4](#4-moleculeの冪等性テストと自動収束)** で扱います。

また、Moleculeシリーズの **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-04/)** で整理したとおり、ansible-lintを通っても、実行して初めて分かる問題があります。Moleculeは、書かれた内容からは判断できない問題を、実行によって見つける側のチェックです。

### 2つのチェックの分担

ここまでを並べると、次のとおりです。

|チェック|判定の方法|守る前提|止めるもの|止められないものの例|
|---|---|---|---|---|
|ansible-lint|書かれた内容を見る（静的）|承認の材料から、適用で何が変わるかを予測できる|確認モードに現れないタスク、あるべき状態をPlaybookの外に委ねるタスク|実行して初めて分かる問題|
|Molecule|実際に実行する（動的）|何度実行しても、同じ状態に収束する|2回目でも変更が出るPlaybook|同じ時点の2回の実行では現れない変化（`state: latest`など）|

どちらか一方では、2つの前提の両方を守れません。ansible-lintは実行しないため、実際に収束するかは分かりません。Moleculeは実行するため、同じ時点の2回の実行で現れない問題は見つけられません。

### 見ているのは、Playbookの品質ではなく前提

Moleculeシリーズの **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-04/)** では、チェックの失敗を、Playbookの設計の問題が見えるようになった状態として読むと整理しました。GitOpsのパイプラインの中では、同じ失敗が、もう1つの意味を持ちます。承認の判断や自動収束が前提にしている条件が崩れた変更が、インフラに届こうとしている、という意味です。

そのため、この回で問うのは、チェックをどう設定するかではなく、次の2点です。

* チェックが失敗したとき、その変更が、どの仕組みによってインフラに届かなくなるのか
* チェックが成功したとき、その成功は、2つの前提が守られていることを意味するのか

1つ目は、**[セクション7](#7-適用前にチェック結果を確認する)** で、承認ゲートの入口にチェックの結果の確認を加えることで扱います。2つ目は、**[セクション5](#5-ガードレールはすり抜けられる)** で扱います。先に言えば、ansible-lintの`no-changed-when`が見ているのは`changed_when`が書かれているかどうかで、Moleculeの冪等性テストが見ているのは`changed`の報告です。どちらも、冪等性シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** で表示の制御にすぎないと確認した`changed_when`の影響を受けます。

次のセクションでは、ansible-lintが承認の材料から漏れるタスクを見つけることを、実機で確認します。

---

[↑ 目次に戻る](#-目次)

---

## 3. ansible-lintで承認の材料から漏れるタスクを見つける

**[セクション2](#2-ガードレールは何を止めるのか)** で整理した、承認の材料に現れないタスクと、あるべき状態をPlaybookの外に委ねるタスクを、ansible-lintが実行の前に見つけることを、実機で確認します。あわせて、今のmainがansible-lintを通るかを確かめ、通る状態にします。

### この検証環境のansible-lint

この検証環境のansible-lintのバージョンと、この回で扱うルールを確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
source ~/ansible-env/bin/activate
ansible-lint --version
ansible-lint -L --nocolor 2>/dev/null | grep -E -A3 '(package-latest|no-changed-when|risky-file-permissions|command-instead-of-shell)'
```

**▼ 実行結果**

```plaintext
ansible-lint 26.6.0 using ansible-core:2.17.14 ansible-compat:26.6.0 ruamel-yaml:0.19.1 ruamel-yaml-clib:0.2.15
（途中省略：新しいバージョンの案内）
- command-instead-of-shell Use shell only when shell functionality is required.
  tags:autofix,command-shell,idiom modified:6.18.0
- complexity Sets maximum complexity to avoid complex plays.
  tags:experimental modified:26.2.0
--
- no-changed-when Commands should not change things if nothing needs doing.
  tags:command-shell,idempotency modified:6.14.5
- no-free-form Rule for detecting discouraged free-form syntax for action modules.
  tags:autofix,syntax,risk modified:6.8.0
--
- package-latest Package installs should not use latest.
  tags:idempotency modified:6.20.0
- parser-error AnsibleParserError.
  tags:core modified:5.0.0
--
- risky-file-permissions File permissions unset or incorrect.
  tags:unpredictability modified:4.3.0
- risky-octal Octal file permissions must contain leading zero or be a string.
  tags:formatting modified:6.9.1
```

ansible-lintは26.6.0、ansible-coreは2.17.14です。この回の判定は、このバージョンでの実測です。`grep`は、前後の行も表示しているため、関係のないルールも含まれています。

この回で扱うのは、次の2つのルールです。どちらにも、`idempotency`のタグが付いています。

|ルール|説明（要約）|
|---|---|
|`no-changed-when`|何も変える必要がないときに、コマンドが変更を起こすべきではない|
|`package-latest`|パッケージのインストールに`latest`を使うべきではない|

### ■ 検証内容：承認の材料に現れないタスクと、state: latest

確認用のタスクファイルを、手元の作業ツリーにだけ置きます。コミットはせず、ansible-lintはPlaybookを実行しないため、操作対象には触れません。1つ目のタスクは、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4で、承認の材料に現れなかった`shell`のタスクと同じ形です。2つ目のタスクは、`state: latest`でパッケージを入れるタスクです。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
cat > roles/common_setup/tasks/gitops08_lint.yml <<'EOF'
---
- name: 確認用の設定ファイルを書き出す（shell）
  become: true
  ansible.builtin.shell: echo "written_by=shell" > /etc/gitops08-shell.conf

- name: 確認用にcurlを最新にする（state latest）
  become: true
  ansible.builtin.apt:
    name: curl
    state: latest
EOF
cat -n roles/common_setup/tasks/gitops08_lint.yml
ansible-lint --nocolor roles/common_setup/tasks/gitops08_lint.yml; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
     1  ---
     2  - name: 確認用の設定ファイルを書き出す（shell）
     3    become: true
     4    ansible.builtin.shell: echo "written_by=shell" > /etc/gitops08-shell.conf
     5
     6  - name: 確認用にcurlを最新にする（state latest）
     7    become: true
     8    ansible.builtin.apt:
     9      name: curl
    10      state: latest
WARNING  Listing 2 violation(s) that are fatal
no-changed-when: Commands should not change things if nothing needs doing.
roles/common_setup/tasks/gitops08_lint.yml:2 Task/Handler: 確認用の設定ファイルを書き出す（shell）

package-latest: Package installs should not use latest.
roles/common_setup/tasks/gitops08_lint.yml:6 Task/Handler: 確認用にcurlを最新にする（state latest）

Read documentation for instructions on how to ignore specific rule violations.

# Rule Violation Summary

  1 package-latest profile:safety tags:idempotency
  1 no-changed-when profile:safety tags:command-shell,idempotency

Failed: 2 failure(s), 0 warning(s) in 1 files processed of 1 encountered. Last profile that met the validation criteria was 'moderate'. Rating: 2/5 star
（途中省略：新しいバージョンの案内）
exit_code=2
```

### ■ 結果

2つのタスクは、どちらも指摘され、ansible-lintは`exit_code=2`で終わりました。

|タスク|指摘したルール|セクション2の前提との関係|
|---|---|---|
|`shell`でファイルを書き出す|`no-changed-when`|確認モードでは`skipping`と表示され、承認の材料に現れない|
|`state: latest`でcurlを入れる|`package-latest`|あるべき状態の定義を、パッケージのリポジトリに委ねている|

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4では、同じ形の`shell`のタスクが、承認の材料には`skipping`としか現れず、本実行で3台にファイルを書き込みました。承認する人がその変更を見る機会は、承認の前にも、適用の記録にもありませんでした。ansible-lintは、このタスクを、Playbookを1回も実行しないうちに指摘しています。

`state: latest`は、**[セクション2](#2-ガードレールは何を止めるのか)** で整理したとおり、Moleculeの冪等性テストでは止められないタスクです。ansible-lintは、書かれた`latest`という値を見て、実行の前に指摘しました。

### ■ 検証内容：state: latestを直した2つの形

`state: latest`を、次の2つの形に直して、もう一度ansible-lintを実行します。

* バージョンを固定して、`state: present`で入れる
* バージョンを指定せずに、`state: present`で入れる

固定するバージョンには、操作対象に実際に入っているcurlのバージョンを使います。

**実行コマンド**

```plaintext
for n in target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n dpkg-query -W -f='${Package} ${Version}\n' curl; done
```

**▼ 実行結果**

```plaintext
== target-node1
curl 7.81.0-1ubuntu1.27
== target-node2
curl 7.81.0-1ubuntu1.27
== target-node3
curl 7.81.0-1ubuntu1.27
```

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
cat > roles/common_setup/tasks/gitops08_lint.yml <<'EOF'
---
- name: 確認用にcurlをバージョンを固定して入れる
  become: true
  ansible.builtin.apt:
    name: curl=7.81.0-1ubuntu1.27
    state: present

- name: 確認用にcurlをバージョンを指定せずに入れる
  become: true
  ansible.builtin.apt:
    name: curl
    state: present
EOF
cat -n roles/common_setup/tasks/gitops08_lint.yml
ansible-lint --nocolor roles/common_setup/tasks/gitops08_lint.yml; echo "exit_code=$?"
rm roles/common_setup/tasks/gitops08_lint.yml
git status --short; echo "git_status_exit_code=$?"
```

**▼ 実行結果**

```plaintext
     1  ---
     2  - name: 確認用にcurlをバージョンを固定して入れる
     3    become: true
     4    ansible.builtin.apt:
     5      name: curl=7.81.0-1ubuntu1.27
     6      state: present
     7
     8  - name: 確認用にcurlをバージョンを指定せずに入れる
     9    become: true
    10    ansible.builtin.apt:
    11      name: curl
    12      state: present

Passed: 0 failure(s), 0 warning(s) in 1 files processed of 1 encountered. Last profile that met the validation criteria was 'production'.
（途中省略：新しいバージョンの案内）
exit_code=0
git_status_exit_code=0
```

### ■ 結果

2つの形は、どちらも指摘されずに通りました（`exit_code=0`）。確認用のタスクファイルは削除し、作業ツリーは元に戻っています。

バージョンを固定した形が通るのは、あるべき状態がPlaybookの中で閉じているためです。一方、バージョンを指定しない`state: present`も、同じように通りました。冪等性シリーズの **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/)** のセクション5では、バージョンを指定しない指定も、どのバージョンが入るかがインストールする時点のリポジトリに依存する、`state: latest`と同じ構造を持つと整理しました。`package-latest`が見ているのは、`latest`と書かれているかどうかです。あるべき状態がPlaybookの中で閉じているかどうかではありません。

ansible-lintを通ったことは、その書き方がルールに反していないことを意味するだけで、あるべき状態がPlaybookの中で閉じていることまでは意味しません。ルールが見ている書き方と、守りたい性質との間の隙間は、**[セクション5](#5-ガードレールはすり抜けられる)** で、`changed_when`について改めて扱います。

### ■ 検証内容：今のmainはansible-lintを通るか

ansible-lintをガードレールとしてパイプラインに組み込むには、まず今のmainが通る必要があります。確認用のファイルを置かない状態で、`ansible/`の全体に対してansible-lintを実行します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
git status --short; echo "git_status_exit_code=$?"
ansible-lint --nocolor; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
git_status_exit_code=0
WARNING  Listing 4 violation(s) that are fatal
internal-error: Unexpected error code 1 from execution of: ansible-playbook --syntax-check -vv /tmp/playc3uajzhm.yml (warning)
roles/common_setup:1 ansible-playbook [core 2.17.14]
（途中省略：ansible-playbookのバージョンと設定の表示）
Using /home/control/iac/docker-lab-ci/ansible/ansible.cfg as config file
ERROR! No inventory was parsed, please check your configuration and options.


risky-file-permissions: File permissions unset or incorrect.
roles/common_setup/tasks/drift_check.yml:2 Task/Handler: ドリフト検知の実演用設定ファイルを配置

name[casing]: All names should start with an uppercase letter.
roles/common_setup/tasks/main.yml:2:9 Task/Handler: drift_check.ymlを読み込み

internal-error: Unexpected error code 1 from execution of: ansible-playbook --syntax-check -vv site.yml (warning)
site.yml:1 ansible-playbook [core 2.17.14]
（途中省略：ansible-playbookのバージョンと設定の表示）
Using /home/control/iac/docker-lab-ci/ansible/ansible.cfg as config file
ERROR! No inventory was parsed, please check your configuration and options.


Read documentation for instructions on how to ignore specific rule violations.

# Rule Violation Summary

  2 internal-error profile:min tags:core
  1 name profile:min tags:idiom
  1 risky-file-permissions profile:min tags:unpredictability

Failed: 4 failure(s), 0 warning(s) in 7 files processed of 9 encountered.
（途中省略：新しいバージョンの案内）
exit_code=2
```

### ■ 結果

今のmainは、4件の違反でansible-lintを通りませんでした（`exit_code=2`）。内訳は、次のとおりです。

|ルール|対象|内容|
|---|---|---|
|`internal-error`（2件）|ロール`common_setup`、`site.yml`|ansible-lintが内部で実行する`ansible-playbook --syntax-check`が、`No inventory was parsed`で失敗した|
|`risky-file-permissions`|`drift_check.yml`の`copy`のタスク|配置するファイルの権限（`mode`）が指定されていない|
|`name[casing]`|`main.yml`の`drift_check.ymlを読み込み`|名前が英大文字で始まっていない|

`name[casing]`が指摘したのは、英小文字の`d`で始まる名前だけでした。`ドリフト検知の実演用設定ファイルを配置`のように、日本語で始まる名前は指摘されていません。

`risky-file-permissions`は、Moleculeシリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-03/)** で、パーミッションの指定を明示しないと実行環境によって異なる状態が設定されうる、と整理したルールです。この`copy`のタスクは、**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** から使っているもので、ファイルの内容はPlaybookに書かれていますが、権限は書かれていませんでした。

`internal-error`は、Playbookの内容ではなく、ansible-lintの実行のしかたから来ています。

### ■ 検証内容：internal-errorの原因

`ansible/`で有効になっている、インベントリに関する設定を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
ansible-config dump --only-changed | grep -i inventory
```

**▼ 実行結果**

```plaintext
INVENTORY_UNPARSED_IS_FAILED(/home/control/iac/docker-lab-ci/ansible/ansible.cfg) = True
```

**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション3で、インベントリを読み込めなかったときにジョブを失敗させるため、`ansible.cfg`に`unparsed_is_failed = True`を設定しました。ansible-lintは、構文の確認に`ansible-playbook --syntax-check`を実行しますが、そのときにインベントリを渡していません。インベントリがないため、この設定によって構文の確認そのものが失敗したと考えられます。

`ansible.cfg`からこの設定を外せば、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で入れた保護も外れます。そこで、ansible-lintを実行するときにだけ、環境変数`ANSIBLE_INVENTORY_UNPARSED_FAILED`で設定を上書きします。あわせて、`risky-file-permissions`の対象のファイルが、操作対象でどの権限になっているかを確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
ANSIBLE_INVENTORY_UNPARSED_FAILED=False ansible-lint --nocolor; echo "exit_code=$?"
for n in target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n stat -c '%a %U:%G %n' /etc/drift-check-target.conf; done
```

**▼ 実行結果**

```plaintext
WARNING  Listing 2 violation(s) that are fatal
risky-file-permissions: File permissions unset or incorrect.
roles/common_setup/tasks/drift_check.yml:2 Task/Handler: ドリフト検知の実演用設定ファイルを配置

name[casing]: All names should start with an uppercase letter.
roles/common_setup/tasks/main.yml:2:9 Task/Handler: drift_check.ymlを読み込み

Read documentation for instructions on how to ignore specific rule violations.

# Rule Violation Summary

  1 name profile:moderate tags:idiom
  1 risky-file-permissions profile:moderate tags:unpredictability

Failed: 2 failure(s), 0 warning(s) in 7 files processed of 9 encountered. Last profile that met the validation criteria was 'basic'. Rating: 1/5 star
（途中省略：新しいバージョンの案内）
exit_code=2
== target-node1
644 root:root /etc/drift-check-target.conf
== target-node2
644 root:root /etc/drift-check-target.conf
== target-node3
644 root:root /etc/drift-check-target.conf
```

### ■ 結果

環境変数で設定を上書きすると、`internal-error`の2件は出なくなり、残りは`risky-file-permissions`と`name[casing]`の2件になりました。`internal-error`の原因が、`unparsed_is_failed`の設定であることが確かめられました。

操作対象の`/etc/drift-check-target.conf`は、3台とも`644`（`root:root`）でした。今の権限をそのまま`mode`に書けば、Playbookを変えても、操作対象は変わらないはずです。

以降、ansible-lintは、この環境変数を付けて実行します。インベントリを読み込めなかったときにジョブを失敗させる保護は、`ansible-playbook`の実行には残したまま、ansible-lintの構文の確認にだけ影響しない形です。

### ■ 検証内容：今のmainを、ansible-lintを通る状態にする

作業用のブランチで、`copy`のタスクに`mode: "0644"`を加え、`main.yml`のタスクの名前を日本語で始まる名前に変えます。そのうえで、ansible-lintと、確認モードの結果を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops08-lint-baseline
sed -i '6a\    mode: "0644"' ansible/roles/common_setup/tasks/drift_check.yml
sed -i '2s/drift_check.ymlを読み込み/ドリフト検知のタスクを読み込み/' ansible/roles/common_setup/tasks/main.yml
git --no-pager diff
cd ansible
ANSIBLE_INVENTORY_UNPARSED_FAILED=False ansible-lint --nocolor; echo "exit_code=$?"
ansible-playbook -i dynamic_inventory.py site.yml --check --diff | tail -4
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops08-lint-baseline'
diff --git a/ansible/roles/common_setup/tasks/drift_check.yml b/ansible/roles/common_setup/tasks/drift_check.yml
index 8c2aa45..d437236 100644
--- a/ansible/roles/common_setup/tasks/drift_check.yml
+++ b/ansible/roles/common_setup/tasks/drift_check.yml
@@ -4,3 +4,4 @@
   ansible.builtin.copy:
     dest: /etc/drift-check-target.conf
     content: "monitored_by=ansible-drift-check\n"
+    mode: "0644"
diff --git a/ansible/roles/common_setup/tasks/main.yml b/ansible/roles/common_setup/tasks/main.yml
index 46dcccd..4c50f59 100644
--- a/ansible/roles/common_setup/tasks/main.yml
+++ b/ansible/roles/common_setup/tasks/main.yml
@@ -1,3 +1,3 @@
 ---
-- name: drift_check.ymlを読み込み
+- name: ドリフト検知のタスクを読み込み
   ansible.builtin.import_tasks: drift_check.yml

Passed: 0 failure(s), 0 warning(s) in 7 files processed of 9 encountered. Last profile that met the validation criteria was 'production'.
（途中省略：新しいバージョンの案内、Pythonのインタープリターに関する警告）
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

ansible-lintは通り（`exit_code=0`）、確認モードでは3台とも`changed=0`でした。この変更をコミットしてプッシュします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git add ansible/roles/common_setup/tasks/drift_check.yml ansible/roles/common_setup/tasks/main.yml
git commit -m "GitOps第8回: ansible-lintを通すため、copyにmodeを指定し、タスク名を直す"
git push -u origin gitops08-lint-baseline
```

**▼ 実行結果**

```plaintext
[gitops08-lint-baseline dc73283] GitOps第8回: ansible-lintを通すため、copyにmodeを指定し、タスク名を直す
 2 files changed, 2 insertions(+), 1 deletion(-)
（途中省略：プッシュの表示）
```

このブランチから、プルリクエスト（`#37`）を作成しました。確認の実行は、「GitOps Pipeline」の`#67`です。ansible-lintは、まだパイプラインに組み込んでいません。

**▼ 実行結果（プルリクエスト`#37`の「GitOps Pipeline」の実行`#67`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
***/roles/common_setup/tasks/drift_check.yml
***/roles/common_setup/tasks/main.yml
base=d2fe88666eec95fc285033e90201b100198b3a62
terraform=false
***=true
```

ログの中の`***`は、`ansible`です。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション5で確認したとおり、この検証環境では、Secretsの値と一致する`ansible`という語が、ログの中で伏せられます。

**▼ 実行結果（「GitOps Pipeline」の実行`#67`、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

`ansible/`だけの変更なので、`terraform-plan`はスキップされ、`ansible-check`が動きました。確認の実行が成功した後に、`#37`をマージしました（マージコミット`f1593f6`）。マージで起動した「GitOps Pipeline」の実行`#68`で、承認待ちが記録されました。

**▼ 実行結果（`#37`のマージの「GitOps Pipeline」の実行`#68`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
total 16
-rw------- 1 control control  5 Oct  8 11:57 ***
-rw------- 1 control control 41 Oct  8 11:57 base
-rw------- 1 control control 41 Oct  8 11:57 commit
-rw------- 1 control control  6 Oct  8 11:57 terraform
base=d2fe88666eec95fc285033e90201b100198b3a62
commit=f1593f603ac8beb1c1f69837aa8f39c7890f10ae
terraform=false
***=true
```

Terraformの変更はないため、保存したplan（`tfplan`）はありません。この承認待ちを、「GitOps Apply」を、ブランチ「main」、破棄のチェックなしで起動して適用しました。次の画像は、その実行`#9`です。`verify`、`ansible-apply`、`clear-pending`が成功し、`terraform-apply`と`discard`はスキップされています。

![GitOps Applyの実行#9。コミットf1593f6に対して手動で起動され、verify、ansible-apply、clear-pendingが成功し、terraform-applyとdiscardはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/section3-lint-baseline-apply-run.png)

**▼ 実行結果（「GitOps Apply」の実行`#9`、`verify`ジョブのステップ「Check commits came from pull requests」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
f1593f603ac8beb1c1f69837aa8f39c7890f10ae: merge of pull request #37
```

**▼ 実行結果（「GitOps Apply」の実行`#9`、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

最後に、作業用のブランチを削除し、終了時点の状態を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline -2
git branch -d gitops08-lint-baseline
git push origin --delete gitops08-lint-baseline
git branch -a
git status --short; echo "git_status_exit_code=$?"
ls -la ~/gitops-pending; echo "exit_code=$?"
cd ansible
ANSIBLE_INVENTORY_UNPARSED_FAILED=False ansible-lint --nocolor; echo "exit_code=$?"
ansible-playbook -i dynamic_inventory.py site.yml --check | tail -4
for n in target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n stat -c '%a %U:%G %n' /etc/drift-check-target.conf; done
```

**▼ 実行結果**

```plaintext
Already on 'main'
Your branch is up to date with 'origin/main'.
Already up to date.
f1593f6 (HEAD -> main, origin/main) Merge pull request #37 from juehara-crypto/gitops08-lint-baseline
dc73283 (origin/gitops08-lint-baseline, gitops08-lint-baseline) GitOps第8回: ansible-lintを通すため、copyにmodeを指定し、タスク名を直す
Deleted branch gitops08-lint-baseline (was dc73283).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops08-lint-baseline
* main
  remotes/origin/main
git_status_exit_code=0
ls: cannot access '/home/control/gitops-pending': No such file or directory
exit_code=2

Passed: 0 failure(s), 0 warning(s) in 7 files processed of 9 encountered. Last profile that met the validation criteria was 'production'.
（途中省略：新しいバージョンの案内、Pythonのインタープリターに関する警告）
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

== target-node1
644 root:root /etc/drift-check-target.conf
== target-node2
644 root:root /etc/drift-check-target.conf
== target-node3
644 root:root /etc/drift-check-target.conf
```

### ■ 結果

mainは`f1593f6`になり、mainのPlaybookは、ansible-lintを通る状態になりました（`Passed`）。承認待ちは適用の後に削除され、確認モードは3台とも`changed=0`、操作対象のファイルの権限は`644`のままです。`mode`を加えても、適用の時点で操作対象は何も変わりませんでした。

このセクションで確認したことを並べると、次のとおりです。

* ansible-lintは、承認の材料に現れない`shell`のタスク（`no-changed-when`）と、あるべき状態をPlaybookの外に委ねる`state: latest`（`package-latest`）を、Playbookを実行する前に指摘した
* バージョンを指定しない`state: present`は、あるべき状態がリポジトリに依存する構造を持つが、`package-latest`は指摘しなかった。ansible-lintが見ているのは、書かれた値である
* 今のmainは、ansible-lintを通らなかった。権限の指定がない`copy`のタスクと、名前の付け方に加え、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で入れた`unparsed_is_failed`が、ansible-lintの構文の確認とぶつかっていた
* `ansible.cfg`の設定は残し、ansible-lintを実行するときだけ環境変数で上書きする形にした。直した内容は、プルリクエスト、承認ゲートを通して適用した

ただし、ここまでのansible-lintは、手元で実行しただけです。パイプラインには組み込んでいないため、指摘を受けるタスクを含むプルリクエストも、今のパイプラインではそのままマージでき、承認ゲートを通れます。パイプラインに組み込む構成は **[セクション6](#6-パス判定でチェックを絞り込む)** で、その結果を適用の条件にする構成は **[セクション7](#7-適用前にチェック結果を確認する)** で扱います。

次のセクションでは、Moleculeの冪等性テストが、第4部の自動収束に対して何を保証するのかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 4. Moleculeの冪等性テストと自動収束

Moleculeの冪等性テストが、GitOpsのパイプラインの中で何を保証するのかを、第4部で作る自動収束との関係から整理します。冪等でないタスクで冪等性テストが失敗することは、Moleculeシリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-02/)** で確認済みのため、ここでは実機での再検証は行いません。

### ずれの検知は、「収束していれば変更は出ない」を前提にしている

第4部（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** 〜 **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**）では、Playbookを定期的に実行して、ずれを検知し、収束させる仕組みを作ります。その原型は、Ansible×Terraformシリーズの **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** で作り、このリポジトリにも残っている`drift-check.yml`です。このワークフローは、`ansible-playbook --check`の出力から`changed`の数を数え、0でなければずれがあると判定して、本実行で収束させます。

この判定は、次の前提の上に成り立っています。

* 収束した状態に対してPlaybookを実行すれば、`changed`は0になる
* したがって、`changed`が0でなければ、収束した状態から何かがずれている

この前提は、Playbookが冪等であるときにだけ成り立ちます。収束した状態に対しても`changed`を返すタスクが1つでもあれば、`changed`が0でないことは、ずれがあることを意味しなくなります。

### 収束しないPlaybookが、パイプラインに載ったとき

収束しないPlaybookが、ここまでのパイプラインと第4部の自動収束に載ったときに何が起きるかを、場面ごとに並べます。第4部の仕組みが、`drift-check.yml`と同じく`changed`の数で判定する形をとる場合の整理です。

|場面|収束しないタスクがあるとき|
|---|---|
|プルリクエストと承認の材料（`--check --diff`）|変更を加えていなくても、そのタスクが毎回`changed`として現れる。承認する人は、今回の変更による差分と、毎回出る差分を見分ける必要がある|
|ずれの検知|実際の状態がずれていなくても、毎回「差分あり」と判定される|
|自動収束|存在しないずれを直すために本実行が走り、その本実行でも`changed`が出る。次の検知でも、また「差分あり」と判定される|

検知と収束のどちらも、エラーにはなりません。Moleculeシリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-02/)** で確認したとおり、冪等でないタスクがあっても、`ansible-playbook`自体は`failed=0`のまま完了するためです。パイプラインの画面では、検知と収束が毎回成功として記録され、その裏で、存在しないずれを直し続けることになります。本物のずれも、毎回出る差分の中に埋もれます。

`shell`や`command`のタスクでは、さらに見え方が変わります。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4で確認したとおり、これらのタスクは確認モードではスキップされるため、`--check`による検知には現れません。一方で、ずれを直すための本実行では毎回実行され、そのたびに操作対象を変えます。検知には見えないまま、収束の処理が走るたびに、操作対象が変わり続けることになります。

### 冪等性テストは、収束の前提をマージの前に確かめる

Moleculeの冪等性テストは、同じPlaybookを続けて実行し、2回目に`changed`が出たタスクがあれば失敗とします。これは、ずれの検知が置いている前提、「収束した状態に対してPlaybookを実行すれば、`changed`は0になる」を、そのまま確かめていることになります。

|観点|ずれの検知（第4部）|Moleculeの冪等性テスト|
|---|---|---|
|いつ|マージして適用した後、定期的に|マージの前|
|どこで|実際の操作対象|テスト用の環境|
|何を見るか|`changed`の数|2回目の実行の`changed`|
|`changed`が出たときの意味|ずれがあるとみなす|そのPlaybookは収束しない|

ずれの検知は、Playbookが収束することを前提にしています。その前提が崩れていないかを、検知の側で確かめることはできません。検知の側から見れば、収束しないPlaybookによる`changed`も、本物のずれによる`changed`も、同じ数として現れるためです。Moleculeの冪等性テストは、この前提を、検知の仕組みとは別の場所で、マージの前に確かめます。

`shell`や`command`のタスクについても、冪等性テストは本実行を2回行うため、確認モードによる検知とは違って、毎回`changed`になることを見つけられます。Moleculeシリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-02/)** で、`command`のタスクが冪等性テストで検出されたのは、このためです。

**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション5で整理した、作り直したリソースにPlaybookの全タスクを適用し直す場面も、同じ前提に立っています。全タスクを適用し直した後に、次の実行で何も変わらないことは、Playbookが収束する場合にだけ期待できます。

### 冪等性テストが保証しないこと

一方で、冪等性テストが通ったことは、自動収束が正しく動くことを保証するものではありません。この回で扱う範囲では、次の3つが残ります。

* **同じ時点の2回の実行では現れない変化**：**[セクション2](#2-ガードレールは何を止めるのか)** で整理したとおり、`state: latest`は、テストの時点では2回目に`changed=0`になります。リポジトリが更新された後の検知で、初めて`changed`が現れます
* **`changed`の報告そのものが正しいか**：冪等性テストが見ているのは、`changed`の報告です。報告を変えるだけの書き方で、このテストを通せるかは、**[セクション5](#5-ガードレールはすり抜けられる)** で確認します
* **テスト用の環境と実際の操作対象の違い**：冪等性テストは、テスト用の環境で実行します。実際の操作対象で同じ結果になるかは、**[セクション9](#9-moleculeが保証する範囲)** で整理します

Moleculeの冪等性テストは、第4部の自動収束が成り立つための前提の1つを、マージの前に確かめるガードレールです。前提のすべてを保証するものではありません。

次のセクションでは、ansible-lintとMoleculeの両方を、表示を変えるだけの書き方ですり抜けられることを、実機で確認します。

---

[↑ 目次に戻る](#-目次)

---

## 5. ガードレールはすり抜けられる

ansible-lintとMoleculeの冪等性テストの両方を、表示を変えるだけの書き方で通せることを、実機で確認します。そのうえで、状態を宣言する書き方と比べます。

### 2つのチェックは、どちらも「表示」を見ている

**[セクション2](#2-ガードレールは何を止めるのか)** で整理したとおり、2つのチェックが見ているものは、次のとおりです。

* ansible-lintの`no-changed-when`は、`command`や`shell`のタスクに、`changed_when`が書かれているかを見る
* Moleculeの冪等性テストは、2回目の実行で、`changed`と報告されたタスクがあるかを見る

冪等性シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** では、`changed_when: false`を付けた`shell`のタスクが、`changed=0`と報告されながら、実行のたびにnginxを再起動していることを確認しました。`changed_when`は、Ansibleが`changed`と報告するかを制御するもので、状態が変わったかを判定するものではありません。

この`changed_when`は、2つのチェックの両方に効きます。`changed_when: false`を書けば、ansible-lintから見れば`changed_when`が書かれたことになり、Moleculeから見れば2回目の実行で`changed`が報告されなくなります。Moleculeシリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-03/)** では、`changed_when: false`を付けても表示の制御にすぎず、`no-changed-when`はこの点への注意を静的な段階で促すルールだと整理しました。ここでは、そのルールそのものが、`changed_when: false`で通ってしまうことを確かめます。

### Moleculeのシナリオを用意する

Moleculeシリーズでは、既存のノードを対象にMoleculeを実行しました。この回では、テスト用のコンテナを実行のたびに作り、テストの後に削除する構成にします。操作対象には触れずに、Playbookを2回実行して結果を比べるためです。

この検証環境のMoleculeは26.6.0で、使えるドライバーは、Molecule本体に含まれる`default`だけです。Moleculeの公式ドキュメント（**[Using docker containers](https://docs.ansible.com/projects/molecule/examples/docker/)**）には、プラグインを使わずに、`community.docker`のモジュールで書いたPlaybookでコンテナを作る例があります。この例をもとに、ロール`common_setup`の下にシナリオを作りました。シナリオのファイルは、作業用のブランチ`gitops08-guardrails`に手元でだけコミットし、まだプッシュしていません。パイプラインへの組み込みは、**[セクション6](#6-パス判定でチェックを絞り込む)** で行います。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git log --oneline -2
find ansible/roles/common_setup -type f | sort
cat -n ansible/roles/common_setup/molecule/default/molecule.yml
cat -n ansible/roles/common_setup/molecule/default/converge.yml
```

**▼ 実行結果**

```plaintext
87a0f93 (HEAD -> gitops08-guardrails) GitOps第8回: common_setupロールのMoleculeのシナリオを追加
f1593f6 (origin/main, main) Merge pull request #37 from juehara-crypto/gitops08-lint-baseline
ansible/roles/common_setup/molecule/default/converge.yml
ansible/roles/common_setup/molecule/default/create.yml
ansible/roles/common_setup/molecule/default/destroy.yml
ansible/roles/common_setup/molecule/default/molecule.yml
ansible/roles/common_setup/tasks/drift_check.yml
ansible/roles/common_setup/tasks/main.yml
     1  ---
     2  driver:
     3    name: default
     4  platforms:
     5    - name: molecule-common-setup
     6      image: ansible-target:ubuntu22.04
     7  provisioner:
     8    name: ansible
     9    env:
    10      ANSIBLE_ROLES_PATH: "${MOLECULE_PROJECT_DIRECTORY}/.."
     1  ---
     2  - name: Converge
     3    hosts: molecule
     4    gather_facts: false
     5    roles:
     6      - common_setup
```

`create.yml`と`destroy.yml`は、公式ドキュメントの例をもとにしたもので、内容は次のとおりです。

* **ファイル名：`ansible/roles/common_setup/molecule/default/create.yml`**

```yaml
---
- name: Create
  hosts: localhost
  gather_facts: false
  vars:
    common_setup_molecule_inventory:
      all:
        hosts: {}
  tasks:
    - name: Create a container
      community.docker.docker_container:
        name: "{{ item.name }}"
        image: "{{ item.image }}"
        state: started
        command: sleep 1d
        log_driver: json-file
      loop: "{{ molecule_yml.platforms }}"

    - name: Add container to molecule_inventory
      vars:
        inventory_partial_yaml: |
          all:
            children:
              molecule:
                hosts:
                  "{{ item.name }}":
                    ansible_connection: community.docker.docker
      ansible.builtin.set_fact:
        common_setup_molecule_inventory: >
          {{ common_setup_molecule_inventory | combine(inventory_partial_yaml | from_yaml, recursive=true) }}
      loop: "{{ molecule_yml.platforms }}"
      loop_control:
        label: "{{ item.name }}"

    - name: Dump molecule_inventory
      ansible.builtin.copy:
        content: |
          {{ common_setup_molecule_inventory | to_yaml }}
        dest: "{{ molecule_ephemeral_directory }}/inventory/molecule_inventory.yml"
        mode: "0600"

    - name: Force inventory refresh
      ansible.builtin.meta: refresh_inventory

    - name: Fail if molecule group is missing
      ansible.builtin.assert:
        that: "'molecule' in groups"
        fail_msg: |
          molecule group was not found inside inventory groups: {{ groups }}
      run_once: true # noqa: run-once[task]
```

* **ファイル名：`ansible/roles/common_setup/molecule/default/destroy.yml`**

```yaml
---
- name: Destroy molecule containers
  hosts: molecule
  gather_facts: false
  tasks:
    - name: Stop and remove container
      delegate_to: localhost
      community.docker.docker_container:
        name: "{{ inventory_hostname }}"
        state: absent
        auto_remove: true

- name: Remove dynamic molecule inventory
  hosts: localhost
  gather_facts: false
  tasks:
    - name: Remove dynamic inventory file
      ansible.builtin.file:
        path: "{{ molecule_ephemeral_directory }}/inventory/molecule_inventory.yml"
        state: absent
```

公式ドキュメントの例との違いと、その理由は次のとおりです。

|項目|変えた点|理由|
|---|---|---|
|テスト用のコンテナ|名前を`molecule-common-setup`、イメージを`ansible-target:ubuntu22.04`にした|操作対象の`target-node1`〜`3`と名前が重ならないようにし、操作対象と同じイメージで試すため|
|`molecule.yml`|`provisioner`の`env`で、`ANSIBLE_ROLES_PATH`を指定した|指定しないと、構文の確認の段階で`the role 'common_setup' was not found`で止まった。ロールを探す場所に、ロールの親（`ansible/roles/`）が含まれていなかった|
|`create.yml`|起動の結果を表示するタスク、コンテナが起動しなかったときにログを表示する部分、インベントリの更新を確かめる2つ目のPlayを省いた|検証に必要な範囲に絞るため|
|`create.yml`|インベントリの初期値から、`all`の下の`molecule: {}`を削った|実行のたびに`Skipping unexpected key (molecule) in group (all)`という警告が出たため|
|`create.yml`|変数名を`common_setup_molecule_inventory`にした|シナリオをロールの下に置いたため、ansible-lintがロールの一部として扱い、`var-naming[no-role-prefix]`で、ロール名の接頭辞を求めたため|

あわせて、`community.docker`のモジュールが必要とする`requests`を、Ansibleを入れたPythonの仮想環境に追加しています。この仮想環境は、パイプラインのジョブも使います。

このシナリオで、今のロールに対して`molecule test`を実行した結果は、次のとおりです。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible/roles/common_setup
molecule test > /tmp/gitops08-molecule-test.log 2>&1; echo "exit_code=$?"
tail -22 /tmp/gitops08-molecule-test.log
rm /tmp/gitops08-molecule-test.log
docker ps -a --filter name=molecule --format '{{.Names}} {{.Status}}'; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
exit_code=0
  └─ Return code: 0 ─────────────────────────────────────────────────────────────────
INFO     default ➜ destroy: Executed: Successful
INFO     default ➜ scenario: Pruning extra files from scenario ephemeral directory
WARNING  Molecule executed 1 scenario (1 missing files)

DETAILS
default ➜ dependency: Executed: 2 missing (Remove from test_sequence to suppress)
default ➜ cleanup: Executed: Missing playbook (Remove from test_sequence to suppress)
default ➜ destroy: Executed: Successful
default ➜ syntax: Executed: Successful
default ➜ create: Executed: Successful
default ➜ prepare: Executed: Missing playbook (Remove from test_sequence to suppress)
default ➜ converge: Executed: Successful
default ➜ idempotence: Executed: Successful
default ➜ side_effect: Executed: Missing playbook (Remove from test_sequence to suppress)
default ➜ verify: Executed: Missing playbook (Remove from test_sequence to suppress)
default ➜ cleanup: Executed: Missing playbook (Remove from test_sequence to suppress)
default ➜ destroy: Executed: Successful
（途中省略：SCENARIO RECAPの見出し行）
default                   : actions=12  successful=6  disabled=0  skipped=0  missing=7  failed=0

exit_code=0
```

`create`でテスト用のコンテナを作り、`converge`と`idempotence`でロールを2回実行して、最後の`destroy`でコンテナを削除しています。`Missing playbook`は、そのフェーズで実行するPlaybookを用意していないという通知で、エラーではありません。今のロールは、冪等性テストを通ります。

### ■ 検証内容：changed_when: falseを付けたshellのタスク

ファイルに1行を追記する`shell`のタスクに、`changed_when: false`を付けて、ロールに加えます。追記なので、実行するたびにファイルの行が増えます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
cat > ansible/roles/common_setup/tasks/gitops08_bypass.yml <<'EOF'
---
- name: 確認用の設定ファイルに1行を追記する（changed_when false）
  become: true
  ansible.builtin.shell: echo "written_by=shell" >> /etc/gitops08-bypass.conf
  changed_when: false
EOF
cat >> ansible/roles/common_setup/tasks/main.yml <<'EOF'
- name: 確認用のタスクを読み込み
  ansible.builtin.import_tasks: gitops08_bypass.yml
EOF
git --no-pager diff
cat -n ansible/roles/common_setup/tasks/gitops08_bypass.yml
```

**▼ 実行結果**

```plaintext
diff --git a/ansible/roles/common_setup/tasks/main.yml b/ansible/roles/common_setup/tasks/main.yml
index 4c50f59..8f5a636 100644
--- a/ansible/roles/common_setup/tasks/main.yml
+++ b/ansible/roles/common_setup/tasks/main.yml
@@ -1,3 +1,5 @@
 ---
 - name: ドリフト検知のタスクを読み込み
   ansible.builtin.import_tasks: drift_check.yml
+- name: 確認用のタスクを読み込み
+  ansible.builtin.import_tasks: gitops08_bypass.yml
     1  ---
     2  - name: 確認用の設定ファイルに1行を追記する（changed_when false）
     3    become: true
     4    ansible.builtin.shell: echo "written_by=shell" >> /etc/gitops08-bypass.conf
     5    changed_when: false
```

この状態で、ansible-lintを実行します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
ANSIBLE_INVENTORY_UNPARSED_FAILED=False ansible-lint --nocolor; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext

Passed: 0 failure(s), 0 warning(s) in 12 files processed of 14 encountered. Last profile that met the validation criteria was 'production'.
（途中省略：新しいバージョンの案内）
exit_code=0
```

続いて、Moleculeで`converge`と`idempotence`を実行し、テスト用のコンテナのファイルを確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible/roles/common_setup
molecule converge; echo "exit_code=$?"
molecule idempotence; echo "exit_code=$?"
docker exec molecule-common-setup sh -c 'wc -l /etc/gitops08-bypass.conf; cat /etc/gitops08-bypass.conf'
```

**▼ 実行結果**

```plaintext
（途中省略：dependency、create、prepareの表示）
INFO     default ➜ converge: Executing
（途中省略：実行したコマンドの表示）
  │ PLAY [Converge] ****************************************************************
  │
  │ TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
  │ changed: [molecule-common-setup]
  │
  │ TASK [common_setup : 確認用の設定ファイルに1行を追記する（changed_when false）] ***
  │ ok: [molecule-common-setup]
  │
  │ PLAY RECAP *********************************************************************
  │ molecule-common-setup      : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │
  └─ Return code: 0 ─────────────────────────────────────────────────────────────────
INFO     default ➜ converge: Executed: Successful
（途中省略：DETAILSとSCENARIO RECAPの表示）
exit_code=0
INFO     default ➜ discovery: scenario test matrix: idempotence
INFO     default ➜ prerun: Performing prerun with role_name_check=0...
INFO     default ➜ idempotence: Executing
（途中省略：実行したコマンドの表示）
  │ PLAY [Converge] ****************************************************************
  │
  │ TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
  │ ok: [molecule-common-setup]
  │
  │ TASK [common_setup : 確認用の設定ファイルに1行を追記する（changed_when false）] ***
  │ ok: [molecule-common-setup]
  │
  │ PLAY RECAP *********************************************************************
  │ molecule-common-setup      : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │
  └─ Return code: 0 ─────────────────────────────────────────────────────────────────
INFO     default ➜ idempotence: Executed: Successful
（途中省略：DETAILSとSCENARIO RECAPの表示）
exit_code=0
2 /etc/gitops08-bypass.conf
written_by=shell
written_by=shell
```

### ■ 結果

`changed_when: false`を付けた`shell`のタスクは、2つのチェックをどちらも通りました。

|確認|結果|
|---|---|
|ansible-lint|`Passed`（`exit_code=0`）。`no-changed-when`の指摘なし|
|Moleculeの`converge`（1回目）|確認用のタスクは`ok`|
|Moleculeの`idempotence`（2回目）|確認用のタスクは`ok`、`changed=0`。`idempotence: Executed: Successful`|
|テスト用のコンテナのファイル|2行（`written_by=shell`が2回）|

表示は2回とも`ok`でしたが、ファイルには2回分の行が書き込まれていました。実行のたびに状態が変わっていて、このタスクは冪等ではありません。それでも、ansible-lintは`changed_when`が書かれていることを見て通し、Moleculeは`changed`が報告されなかったことを見て、冪等性テストを成功としました。

**[セクション4](#4-moleculeの冪等性テストと自動収束)** で整理した自動収束に、このタスクが載った場合を考えます。収束の処理が走るたびに、ファイルには行が追加されます。一方で、`changed`は報告されないため、ずれの検知にも収束の結果にも、その変化は現れません。冪等性テストを通ったことが、自動収束の前提を守っていることを意味しなくなります。

### ■ 検証内容：状態を宣言するモジュールに置き換える

同じタスクを、`copy`のモジュールで、ファイルのあるべき内容を宣言する形に置き換えます。新しいテスト用のコンテナで比べるため、Moleculeの`destroy`で、いったんコンテナを削除してから実行します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
cat > ansible/roles/common_setup/tasks/gitops08_bypass.yml <<'EOF'
---
- name: 確認用の設定ファイルを配置する（copy）
  become: true
  ansible.builtin.copy:
    dest: /etc/gitops08-bypass.conf
    content: "written_by=copy\n"
    mode: "0644"
EOF
cat -n ansible/roles/common_setup/tasks/gitops08_bypass.yml
cd ansible
ANSIBLE_INVENTORY_UNPARSED_FAILED=False ansible-lint --nocolor; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
     1  ---
     2  - name: 確認用の設定ファイルを配置する（copy）
     3    become: true
     4    ansible.builtin.copy:
     5      dest: /etc/gitops08-bypass.conf
     6      content: "written_by=copy\n"
     7      mode: "0644"

Passed: 0 failure(s), 0 warning(s) in 12 files processed of 14 encountered. Last profile that met the validation criteria was 'production'.
（途中省略：新しいバージョンの案内）
exit_code=0
```

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible/roles/common_setup
molecule destroy; echo "exit_code=$?"
molecule converge; echo "exit_code=$?"
molecule idempotence; echo "exit_code=$?"
docker exec molecule-common-setup sh -c 'wc -l /etc/gitops08-bypass.conf; cat /etc/gitops08-bypass.conf'
```

**▼ 実行結果**

```plaintext
（途中省略：destroyの表示）
exit_code=0
（途中省略：dependency、create、prepareの表示）
INFO     default ➜ converge: Executing
（途中省略：実行したコマンドの表示）
  │ PLAY [Converge] ****************************************************************
  │
  │ TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
  │ changed: [molecule-common-setup]
  │
  │ TASK [common_setup : 確認用の設定ファイルを配置する（copy）] *******************
  │ changed: [molecule-common-setup]
  │
  │ PLAY RECAP *********************************************************************
  │ molecule-common-setup      : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │
  └─ Return code: 0 ─────────────────────────────────────────────────────────────────
INFO     default ➜ converge: Executed: Successful
（途中省略：DETAILSとSCENARIO RECAPの表示）
exit_code=0
INFO     default ➜ discovery: scenario test matrix: idempotence
INFO     default ➜ prerun: Performing prerun with role_name_check=0...
INFO     default ➜ idempotence: Executing
（途中省略：実行したコマンドの表示）
  │ PLAY [Converge] ****************************************************************
  │
  │ TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
  │ ok: [molecule-common-setup]
  │
  │ TASK [common_setup : 確認用の設定ファイルを配置する（copy）] *******************
  │ ok: [molecule-common-setup]
  │
  │ PLAY RECAP *********************************************************************
  │ molecule-common-setup      : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
  │
  └─ Return code: 0 ─────────────────────────────────────────────────────────────────
INFO     default ➜ idempotence: Executed: Successful
（途中省略：DETAILSとSCENARIO RECAPの表示）
exit_code=0
1 /etc/gitops08-bypass.conf
written_by=copy
```

最後に、テスト用のコンテナを削除し、確認用のタスクを取り除きます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible/roles/common_setup
molecule destroy; echo "exit_code=$?"
cd ~/iac/docker-lab-ci
rm ansible/roles/common_setup/tasks/gitops08_bypass.yml
git restore ansible/roles/common_setup/tasks/main.yml
git status --short; echo "git_status_exit_code=$?"
docker ps -a --filter name=molecule --format '{{.Names}} {{.Status}}'; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
（途中省略：destroyの表示）
exit_code=0
git_status_exit_code=0
exit_code=0
```

### ■ 結果

`copy`に置き換えたタスクも、2つのチェックを通りました。違うのは、2つのチェックが成功と表示した理由と、実際の状態です。

|書き方|ansible-lint|Moleculeの冪等性テスト|テスト用のコンテナのファイル|
|---|---|---|---|
|`shell`＋`changed_when: false`|通る|通る（表示は2回とも`ok`）|2行。実行のたびに増える|
|`copy`|通る|通る（1回目は`changed`、2回目は`ok`）|1行。2回目は何も変わらない|

`copy`のタスクは、1回目の実行でファイルを作って`changed`と報告し、2回目の実行では、ファイルがすでにあるべき内容であることを確かめて`ok`と報告しました。冪等性シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** で整理したとおり、この`ok`は、現在の状態を観測した結果です。一方、`changed_when: false`の`ok`は、`changed`と報告しない設定の結果で、2回とも同じ`ok`でした。2つのチェックから見ると、この2つの`ok`は区別できません。

テスト用のコンテナは削除され、作業ツリーは、シナリオのコミット（`87a0f93`）だけの状態に戻りました。

### 通すことと、冪等であることは別

`changed_when`のない`shell`のタスクを含めて、3つの書き方を並べると、次のとおりです。

|書き方|ansible-lint|Moleculeの冪等性テスト|冪等か|
|---|---|---|---|
|`shell`（`changed_when`なし）|止まる（`no-changed-when`、**[セクション3](#3-ansible-lintで承認の材料から漏れるタスクを見つける)**）|止まる（Moleculeシリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-02/)**）|冪等でない|
|`shell`＋`changed_when: false`|通る|通る|冪等でない|
|`copy`（状態を宣言する）|通る|通る|冪等|

ガードレールが止めるのは、1行目だけです。2行目と3行目は、どちらのチェックからも同じに見えます。チェックの指摘に従って`changed_when: false`を加えると、指摘は消え、チェックは成功します。しかし、Playbookが冪等になったわけではありません。

`changed_when: false`そのものが、誤った書き方というわけでもありません。冪等性シリーズの **[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-10/)** では、状態を読み取るだけのコマンドに`changed_when: false`を付ける使い方を、正しい使い方として示しました。Moleculeシリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-03/)** で、ansible-lintを実行するタスクに付けたのも同じ使い方です。正しい使い方と、すり抜けのための使い方は、書き方としては同じで、ansible-lintには区別できません。区別できるのは、そのコマンドが何をするのかを読んだ人だけです。

同じことは、ルールの例外の指定にも言えます。この回の`create.yml`には、公式ドキュメントの例から引き継いだ`# noqa: run-once[task]`があり、この行は`run-once[task]`のルールの対象から外れています。例外の指定は、Gitの差分として残るため、プルリクエストのレビューで見ることができます。逆に言えば、例外が妥当かを判断するのは、レビューする人です。

冪等にするには、冪等性シリーズの **[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-10/)** で整理したとおり、`copy`のように状態を宣言するモジュールに置き換えるか、`creates`や`stat`のように現在の状態を観測する条件を、`shell`の周囲に持ち込む必要があります。どちらも、Playbookを書く側の設計です。ガードレールは、その設計の結果を表示から確かめるもので、設計の代わりにはなりません。

ガードレールを通したことは、チェックが見ている範囲で問題が見つからなかったことを意味するだけです。冪等であることや、承認の材料から予測できることまでは保証しません。この限界を前提に、ガードレールが止めるものを、確実にインフラに届かないようにすることが、次の段階になります。

次のセクションでは、2つのチェックをパイプラインに組み込み、変更されたパスで実行を絞り込みます。

---

[↑ 目次に戻る](#-目次)

---

## 6. パス判定でチェックを絞り込む

ansible-lintとMoleculeを、パイプラインのジョブとして組み込みます。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のパス判定を使って、`ansible/`に変更があるときだけ実行し、ansible-lintをMoleculeより先に実行する構成にします。

### ジョブの構成

`gitops-pipeline.yml`に、次の2つのジョブを加えます。

|ジョブ|動く条件|実行すること|
|---|---|---|
|`ansible-lint`|`ansible/`に変更あり|`ansible/`で、ansible-lintを実行する|
|`molecule`|`ansible/`に変更あり、かつ`ansible-lint`が成功|ロール`common_setup`で、`molecule test`を実行する|

この構成で決めたことは、次の3つです。

* **パスによる絞り込み**：2つのジョブは、`changes`ジョブの`ansible`の判定が`true`のときだけ動きます。Terraformだけの変更では動かしません。Moleculeが試すのは、使い捨てのコンテナに対するロール単体の動きで、Terraformの変更はその結果に関係しないためです。Terraformの変更がAnsibleの実行に及ぼす影響は、これまでどおり`ansible-check`（実際の操作対象に対する`--check --diff`）で確かめます
* **ansible-lintを先に、独立したジョブで**：Moleculeシリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-03/)** では、ansible-lintをMoleculeの`verify`のフェーズの中で実行しました。この回では、ansible-lintを独立したジョブにして、Moleculeの前に置きます。理由は、実行時間と、失敗の切り分けです。ansible-lintはPlaybookを実行しないため、コンテナを作るMoleculeより早く終わります。また、失敗したときに、どちらのチェックで止まったかが、ジョブの名前で分かります
* **プルリクエストとマージの両方で実行**：2つのジョブは、`ansible-check`と同じく、プルリクエストだけでなく、マージ（mainへのプッシュ）でも動かします。適用されるのは、マージの後のmainのコミットです。そのコミットのチェックの結果を、**[セクション7](#7-適用前にチェック結果を確認する)** で適用の条件にするためです

`molecule`ジョブの`needs`には、`ansible-lint`を指定します。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション6で確認したとおり、`needs`で指定したジョブが失敗またはスキップされると、条件式で処理を続けない限り、後のジョブもスキップされます。ここでは、その既定の動きをそのまま使います。ansible-lintが失敗すればMoleculeは動かず、`ansible/`に変更がなくansible-lintがスキップされれば、Moleculeもスキップされます。

### ■ 検証内容：ジョブの追加

**[セクション5](#5-ガードレールはすり抜けられる)** でシナリオをコミットした作業用のブランチ`gitops08-guardrails`で、`changes`ジョブの後に2つのジョブを挿入します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git branch --show-current
sed -n '54,57p' .github/workflows/gitops-pipeline.yml
cat > /tmp/gitops08-jobs.yml <<'EOF'
  ansible-lint:
    needs: changes
    if: needs.changes.outputs.ansible == 'true'
    runs-on: [self-hosted, Linux, X64]
    steps:
      - uses: actions/checkout@v4
      - name: Add Ansible to PATH
        run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
      - name: Ansible lint
        working-directory: ansible
        env:
          ANSIBLE_INVENTORY_UNPARSED_FAILED: "False"
        run: ansible-lint --nocolor

  molecule:
    needs: [changes, ansible-lint]
    if: needs.changes.outputs.ansible == 'true'
    runs-on: [self-hosted, Linux, X64]
    steps:
      - uses: actions/checkout@v4
      - name: Add Ansible to PATH
        run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
      - name: Molecule test
        working-directory: ansible/roles/common_setup
        run: molecule test

EOF
sed -i '55r /tmp/gitops08-jobs.yml' .github/workflows/gitops-pipeline.yml
rm /tmp/gitops08-jobs.yml
git --no-pager diff
python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1])); print("yaml ok")' .github/workflows/gitops-pipeline.yml
grep -n -E '^  [a-z-]+:$|ansible-playbook' .github/workflows/gitops-pipeline.yml
```

**▼ 実行結果**

```plaintext
gitops08-guardrails
          cat "$GITHUB_OUTPUT"

  terraform-plan:
    needs: changes
diff --git a/.github/workflows/gitops-pipeline.yml b/.github/workflows/gitops-pipeline.yml
index 673984f..25aca72 100644
--- a/.github/workflows/gitops-pipeline.yml
+++ b/.github/workflows/gitops-pipeline.yml
@@ -53,6 +53,32 @@ jobs:
           fi
           cat "$GITHUB_OUTPUT"

+  ansible-lint:
+    needs: changes
+    if: needs.changes.outputs.ansible == 'true'
+    runs-on: [self-hosted, Linux, X64]
+    steps:
+      - uses: actions/checkout@v4
+      - name: Add Ansible to PATH
+        run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
+      - name: Ansible lint
+        working-directory: ansible
+        env:
+          ANSIBLE_INVENTORY_UNPARSED_FAILED: "False"
+        run: ansible-lint --nocolor
+
+  molecule:
+    needs: [changes, ansible-lint]
+    if: needs.changes.outputs.ansible == 'true'
+    runs-on: [self-hosted, Linux, X64]
+    steps:
+      - uses: actions/checkout@v4
+      - name: Add Ansible to PATH
+        run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
+      - name: Molecule test
+        working-directory: ansible/roles/common_setup
+        run: molecule test
+
   terraform-plan:
     needs: changes
     if: needs.changes.outputs.terraform == 'true'
yaml ok
7:  push:
21:  changes:
56:  ansible-lint:
70:  molecule:
82:  terraform-plan:
104:  ansible-check:
122:        run: ansible-playbook -i dynamic_inventory.py site.yml --check --diff
128:  record-pending:
```

ansible-lintには、**[セクション3](#3-ansible-lintで承認の材料から漏れるタスクを見つける)** で決めたとおり、環境変数`ANSIBLE_INVENTORY_UNPARSED_FAILED`を、このステップにだけ渡しています。

この変更をコミットし、シナリオのコミットとあわせてプッシュします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git add .github/workflows/gitops-pipeline.yml
git commit -m "GitOps第8回: ansible-lintとMoleculeのジョブを追加"
git push -u origin gitops08-guardrails
git log --oneline -3
```

**▼ 実行結果**

```plaintext
[gitops08-guardrails 3e51964] GitOps第8回: ansible-lintとMoleculeのジョブを追加
 1 file changed, 26 insertions(+)
（途中省略：プッシュの表示）
3e51964 (HEAD -> gitops08-guardrails, origin/gitops08-guardrails) GitOps第8回: ansible-lintとMoleculeのジョブを追加
87a0f93 GitOps第8回: common_setupロールのMoleculeのシナリオを追加
f1593f6 (origin/main, main) Merge pull request #37 from juehara-crypto/gitops08-lint-baseline
```

このブランチから、プルリクエスト（`#38`）を作成しました。次の画像は、その確認の実行、「GitOps Pipeline」の`#69`です。`changes`の後に、`ansible-lint`、`molecule`の順に動いて成功し、`terraform-plan`と`record-pending`はスキップされています。

![GitOps Pipelineの実行#69。プルリクエスト#38の確認として起動され、changes、ansible-lint（21秒）、molecule（44秒）、ansible-check（24秒）が成功し、terraform-planとrecord-pendingはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/section6-guardrails-pr-run.png)

**▼ 実行結果（プルリクエスト`#38`の「GitOps Pipeline」の実行`#69`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
.github/workflows/gitops-pipeline.yml
***/roles/common_setup/molecule/default/converge.yml
***/roles/common_setup/molecule/default/create.yml
***/roles/common_setup/molecule/default/destroy.yml
***/roles/common_setup/molecule/default/molecule.yml
base=f1593f603ac8beb1c1f69837aa8f39c7890f10ae
terraform=false
***=true
```

**▼ 実行結果（「GitOps Pipeline」の実行`#69`、`ansible-lint`ジョブのステップ「Ansible lint」）**

```plaintext
Run ***-lint --nocolor
（途中省略：実行したスクリプト、シェル、環境変数の表示）

Passed: 0 failure(s), 0 warning(s) in 11 files processed of 12 encountered. Last profile that met the validation criteria was 'production'.
（途中省略：新しいバージョンの案内）
```

**▼ 実行結果（「GitOps Pipeline」の実行`#69`、`molecule`ジョブのステップ「Molecule test」から抜粋）**

```plaintext
Run molecule test
（途中省略：実行したスクリプト、シェル、環境変数の表示、フェーズごとの実行の表示）

DETAILS
default > dependency: Executed: 2 missing (Remove from test_sequence to suppress)
default > cleanup: Executed: Missing playbook (Remove from test_sequence to suppress)
default > destroy: Executed: Successful
default > syntax: Executed: Successful
default > create: Executed: Successful
default > prepare: Executed: Missing playbook (Remove from test_sequence to suppress)
default > converge: Executed: Successful
default > idempotence: Executed: Successful
default > side_effect: Executed: Missing playbook (Remove from test_sequence to suppress)
default > verify: Executed: Missing playbook (Remove from test_sequence to suppress)
default > cleanup: Executed: Missing playbook (Remove from test_sequence to suppress)
default > destroy: Executed: Successful

SCENARIO RECAP
default                   : actions=12  successful=6  disabled=0  skipped=0  missing=7  failed=0
```

### ■ 結果

ワークフローのファイルとシナリオのファイルを変えたプルリクエストでは、`ansible`の判定が`true`になり、ansible-lint、Moleculeの順に動いて、どちらも成功しました。所要時間は、ansible-lintが21秒、Moleculeが44秒でした。ansible-lintは、Moleculeの半分ほどの時間で結果を返しています。

ジョブの中のMoleculeのログは、手元で実行したときと形式が違いました。手元では、`converge`や`idempotence`で実行したタスクと`PLAY RECAP`が表示されましたが、ジョブのログには、`[default > converge] Executed: Successful`のように、フェーズごとの結果だけが表示されています。端末ではない環境で実行したためと考えられます。冪等性テストが失敗したときに、原因のタスクがジョブのログにどう表示されるかは、この回では確認していません。

続いて、`#38`をマージしました（マージコミット`81369eb`）。マージで起動した「GitOps Pipeline」の実行`#70`でも、`ansible-lint`、`molecule`、`ansible-check`、`record-pending`が成功し、承認待ちが記録されました。

**▼ 実行結果（`#38`のマージの「GitOps Pipeline」の実行`#70`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示、ファイルの一覧）
base=f1593f603ac8beb1c1f69837aa8f39c7890f10ae
commit=81369eba99b9ff02f3a3d9a072fc750c381e635e
terraform=false
***=true
```

この承認待ちは、「GitOps Apply」の実行`#10`で適用しました。`verify`は`81369eb`をプルリクエスト`#38`のマージと判定し、`ansible-apply`は3台とも`changed=0`で終わっています。

**▼ 実行結果（「GitOps Apply」の実行`#10`、`verify`ジョブのステップ「Check commits came from pull requests」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
81369eba99b9ff02f3a3d9a072fc750c381e635e: merge of pull request #38
```

**▼ 実行結果（「GitOps Apply」の実行`#10`、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

### ■ 検証内容：Terraformだけの変更

mainを更新し、`terraform/main.tf`にコメント行を1行加えるだけのブランチを作ります。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops08-tf-only
echo '# GitOps第8回: Terraformだけの変更の確認用' >> terraform/main.tf
git --no-pager diff
git add terraform/main.tf
git commit -m "GitOps第8回: Terraformだけの変更の確認用のコメント行を追加"
git push -u origin gitops08-tf-only
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops08-tf-only'
diff --git a/terraform/main.tf b/terraform/main.tf
index 4b059ba..b75eb0b 100644
--- a/terraform/main.tf
+++ b/terraform/main.tf
@@ -132,3 +132,4 @@ output "target_nodes_ips" {
 resource "tls_private_key" "generated" {
   algorithm = "ED25519"
 }
+# GitOps第8回: Terraformだけの変更の確認用
[gitops08-tf-only fc6ab74] GitOps第8回: Terraformだけの変更の確認用のコメント行を追加
 1 file changed, 1 insertion(+)
（途中省略：プッシュの表示）
```

このブランチから、プルリクエスト（`#39`）を作成しました。次の画像は、その確認の実行、「GitOps Pipeline」の`#71`です。

![GitOps Pipelineの実行#71。プルリクエスト#39の確認として起動され、changes、terraform-plan、ansible-checkが成功し、ansible-lint、molecule、record-pendingはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/section6-terraform-only-run.png)

**▼ 実行結果（プルリクエスト`#39`の「GitOps Pipeline」の実行`#71`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
terraform/main.tf
base=81369eba99b9ff02f3a3d9a072fc750c381e635e
terraform=true
***=false
```

`terraform/main.tf`だけの変更なので、`terraform`の判定が`true`、`ansible`の判定が`false`になりました。`terraform-plan`と`ansible-check`が動き、`ansible-lint`と`molecule`はスキップされています。このプルリクエストは、確認のためのものなので、マージせずに閉じ、ブランチを削除しました。

### ■ 検証内容：ansible-lintに指摘されるタスク

mainから、`changed_when`のない`shell`のタスクをロールに加えるブランチを作ります。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops08-lint-fail
cat > ansible/roles/common_setup/tasks/gitops08_lint_fail.yml <<'EOF'
---
- name: 確認用の設定ファイルに1行を追記する（changed_whenなし）
  become: true
  ansible.builtin.shell: echo "written_by=shell" >> /etc/gitops08-lint-fail.conf
EOF
cat >> ansible/roles/common_setup/tasks/main.yml <<'EOF'
- name: 確認用のタスクを読み込み
  ansible.builtin.import_tasks: gitops08_lint_fail.yml
EOF
git --no-pager diff
cat -n ansible/roles/common_setup/tasks/gitops08_lint_fail.yml
git add ansible/roles/common_setup/tasks/
git commit -m "GitOps第8回: ansible-lintに指摘されるタスクの確認用"
git push -u origin gitops08-lint-fail
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops08-lint-fail'
diff --git a/ansible/roles/common_setup/tasks/main.yml b/ansible/roles/common_setup/tasks/main.yml
index 4c50f59..4e0705f 100644
--- a/ansible/roles/common_setup/tasks/main.yml
+++ b/ansible/roles/common_setup/tasks/main.yml
@@ -1,3 +1,5 @@
 ---
 - name: ドリフト検知のタスクを読み込み
   ansible.builtin.import_tasks: drift_check.yml
+- name: 確認用のタスクを読み込み
+  ansible.builtin.import_tasks: gitops08_lint_fail.yml
     1  ---
     2  - name: 確認用の設定ファイルに1行を追記する（changed_whenなし）
     3    become: true
     4    ansible.builtin.shell: echo "written_by=shell" >> /etc/gitops08-lint-fail.conf
[gitops08-lint-fail 7e2f6f3] GitOps第8回: ansible-lintに指摘されるタスクの確認用
 2 files changed, 6 insertions(+)
 create mode 100644 ansible/roles/common_setup/tasks/gitops08_lint_fail.yml
（途中省略：プッシュの表示）
```

このブランチから、プルリクエスト（`#40`）を作成しました。次の画像は、その確認の実行、「GitOps Pipeline」の`#72`です。

![GitOps Pipelineの実行#72。プルリクエスト#40の確認として起動され、状態はFailure。ansible-lintが失敗し、moleculeはスキップされている。changesとansible-checkは成功し、terraform-planとrecord-pendingはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/section6-lint-fail-run.png)

**▼ 実行結果（プルリクエスト`#40`の「GitOps Pipeline」の実行`#72`、`ansible-lint`ジョブのステップ「Ansible lint」）**

```plaintext
Run ***-lint --nocolor
（途中省略：実行したスクリプト、シェル、環境変数の表示）
WARNING  Listing 1 violation(s) that are fatal
Error: Commands should not change things if nothing needs doing.
Read documentation for instructions on how to ignore specific rule violations.

# Rule Violation Summary

  1 no-changed-when profile:shared tags:command-shell,idempotency

Failed: 1 failure(s), 0 warning(s) in 12 files processed of 13 encountered. Last profile that met the validation criteria was 'safety'. Rating: 3/5 star
no-changed-when: Commands should not change things if nothing needs doing.
（途中省略：新しいバージョンの案内）
roles/common_setup/tasks/gitops08_lint_fail.yml:2 Task/Handler: 確認用の設定ファイルに1行を追記する（changed_whenなし）
```

ジョブのログでは、手元で実行したときと行の順が入れ替わって表示されていますが、指摘の内容は、ルール`no-changed-when`と、対象のファイルと行（`gitops08_lint_fail.yml:2`）です。`Error:`で始まる行は、GitHub Actionsが、ansible-lintの指摘を注釈として表示したものと考えられます。

ansible-lintが失敗したため、`molecule`はスキップされ、実行全体は「Failure」になりました。`ansible-check`は、ansible-lintの結果とは関係なく動き、成功しています。確認モードでは`shell`のタスクがスキップされるためです。このプルリクエストも、マージせずに閉じ、ブランチを削除しました。

最後に、終了時点の状態を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git branch -a
git status --short; echo "git_status_exit_code=$?"
git log --oneline -1
ls -la ~/gitops-pending; echo "exit_code=$?"
docker ps -a --format '{{.Names}} {{.Status}}' | sort
for n in target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n sh -c 'ls -l /etc/gitops08-* 2>&1'; done
cd ansible
ansible-playbook -i dynamic_inventory.py site.yml --check | tail -4
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えの表示）
* main
  remotes/origin/main
git_status_exit_code=0
81369eb (HEAD -> main, origin/main) Merge pull request #38 from juehara-crypto/gitops08-guardrails
ls: cannot access '/home/control/gitops-pending': No such file or directory
exit_code=2
target-node1 Up 16 hours
target-node2 Up 16 hours
target-node3 Up 16 hours
tfstate-pg Up 16 hours
== target-node1
ls: cannot access '/etc/gitops08-*': No such file or directory
== target-node2
ls: cannot access '/etc/gitops08-*': No such file or directory
== target-node3
ls: cannot access '/etc/gitops08-*': No such file or directory
（途中省略：Pythonのインタープリターに関する警告）
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

3つのプルリクエストで、どのジョブが動いたかを並べると、次のとおりです。

|プルリクエスト|変更|`ansible-lint`|`molecule`|`terraform-plan`|`ansible-check`|実行全体|
|---|---|---|---|---|---|---|
|`#38`（「GitOps Pipeline」`#69`）|ワークフローとシナリオ|成功（21秒）|成功（44秒）|スキップ|成功|Success|
|`#39`（`#71`）|`terraform/`だけ|スキップ|スキップ|成功|成功|Success|
|`#40`（`#72`）|`changed_when`のない`shell`のタスク|失敗（20秒）|スキップ|スキップ|成功|Failure|

`ansible/`に変更があるときだけ、ansible-lintとMoleculeが動きました。ansible-lintが失敗した`#40`では、Moleculeは動かず、失敗はansible-lintのジョブの名前で分かりました。コンテナを作る前に、20秒で結果が返っています。

終了時点では、mainは`81369eb`で、2つのジョブが入っています。確認用のプルリクエストはどちらも閉じ、操作対象には確認用のファイルは作られていません。

ただし、`#40`は「Failure」でしたが、ここで止まったのは、プルリクエストの画面に失敗の印が付いたことだけです。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5で確認したとおり、この検証環境では、ブランチ保護のルールが強制されないため、チェックが失敗していてもマージできます。マージすれば、承認待ちが記録され、承認ゲートの入口も、プルリクエストを通ったコミットとして通します。チェックの結果は、まだフィードバックにとどまっていて、インフラに届くかどうかとは結びついていません。

また、パスによる絞り込みには、絞り込みの外側があります。ワークフローのファイルだけの変更では、`ansible`の判定は`false`になり、ansible-lintもMoleculeも動きません。ガードレールそのものを外す変更は、ガードレールの対象になりません。この点は、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション5で整理した、入口の確認もワークフローのファイルに書かれている、という限界と同じ構造です。

次のセクションでは、チェックの結果を、適用の条件にします。

---

[↑ 目次に戻る](#-目次)

---

## 7. 適用前にチェック結果を確認する

ansible-lintとMoleculeの結果を、インフラに適用するための条件にします。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** で組んだ承認ゲートの入口に、チェックの結果を確かめるステップを加え、チェックを通っていないコミットが適用されないことを、実機で確認します。

### チェックの失敗は、マージを止めない

Moleculeシリーズの **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-04/)** では、CIが失敗すればマージされないことで、問題のあるPlaybookの混入を防ぐ構造として整理しました。この構造が成り立つのは、チェックの成功をマージの条件にする仕組みが、リポジトリで強制されている場合です。GitHubでは、ブランチ保護かルールセットで、必須のチェック（required status checks）を指定します。

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5で確認したとおり、この検証環境の非公開リポジトリでは、ブランチ保護のルールを作成しても「Not enforced」と表示され、強制されません。必須のチェックも、同じルールの中で指定するものです。**[セクション6](#6-パス判定でチェックを絞り込む)** でも、ansible-lintが失敗したプルリクエストには失敗の印が付いただけで、マージそのものは止まりませんでした。

そこで、**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で示した方針のとおり、強制する場所を「mainに入る前」から「インフラに適用する前」に移します。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、この方針で、プルリクエストを通ったコミットかを、承認ゲートの入口で確かめました。この回では、同じ入口で、チェックの結果も確かめます。

### 適用するコミットの、チェックの結果を確かめる

確かめ方は、次のように決めました。

|決めたこと|内容|
|---|---|
|どこで確かめるか|「GitOps Apply」の`verify`ジョブに、ステップ「Check guardrail results」を加える|
|何を確かめるか|適用するコミット（mainの先頭）に対する、`ansible-lint`と`molecule`のジョブの結果|
|どう取り出すか|GitHubのAPI「List check runs for a Git reference」（**[REST API endpoints for check runs](https://docs.github.com/en/rest/checks/runs)**）で、ジョブの名前ごとに結果（`conclusion`）を取り出す。同じ名前の結果が複数あるときは、開始時刻が最も新しいものを採る|
|いつ確かめるか|承認待ちの`ansible`の判定が`true`のとき。`false`のときは、2つのジョブは動いていないため、このステップはスキップする|
|何を通すか|2つとも`success`のときだけ。失敗（`failure`）、スキップ（`skipped`）、結果が見つからない場合（`missing`）は、どれも止める|

確かめる対象を、プルリクエストの確認の実行ではなく、mainのコミットにしたのは、適用されるのがmainのコミットだからです。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション2で確認したとおり、プルリクエストの確認は、確認の実行が動いた時点のmainにマージした結果に対して行われ、その後にmainが進んでも再実行されません。**[セクション6](#6-パス判定でチェックを絞り込む)** で、2つのジョブをマージ（mainへのプッシュ）でも動かすようにしたのは、このためです。

結果は、ランナーのホストの承認待ちの記録に書き込むのではなく、GitHubに残るジョブの結果から読み出します。ホストのファイルを経由せず、適用するコミットに付いた結果を、適用の直前に直接確かめるためです。

### ■ 検証内容：確認のステップの追加

作業用のブランチで、`gitops-apply.yml`の「Check commits came from pull requests」の後ろに、新しいステップを挿入します。あわせて、APIでチェックの結果を読むために、`permissions`に`checks: read`を加えます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git switch -c gitops08-check-gate
sed -n '15,18p;92,96p' .github/workflows/gitops-apply.yml
cat > /tmp/gitops08-step.yml <<'EOF'
      - name: Check guardrail results
        if: steps.pending.outputs.ansible == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          ng=0
          for name in ansible-lint molecule; do
            conclusion=$(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
              "https://api.github.com/repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/check-runs?check_name=$name" \
              | jq -r '[.check_runs[] | select(.app.slug == "github-actions")] | sort_by(.started_at) | last | .conclusion // "missing"')
            echo "$name: $conclusion"
            if [ "$conclusion" != "success" ]; then
              echo "::error::$name on $GITHUB_SHA is $conclusion"
              ng=1
            fi
          done
          exit $ng
EOF
sed -i '94r /tmp/gitops08-step.yml' .github/workflows/gitops-apply.yml
sed -i '17a\  checks: read' .github/workflows/gitops-apply.yml
rm /tmp/gitops08-step.yml
git --no-pager diff
python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1])); print("yaml ok")' .github/workflows/gitops-apply.yml
grep -n -E '^  [a-z-]+:$|- name:|ansible-playbook' .github/workflows/gitops-apply.yml
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えの表示）
permissions:
  contents: read
  pull-requests: read

            fi
          done
          exit $ng

  terraform-apply:
diff --git a/.github/workflows/gitops-apply.yml b/.github/workflows/gitops-apply.yml
index c4c4c3e..e3e27cc 100644
--- a/.github/workflows/gitops-apply.yml
+++ b/.github/workflows/gitops-apply.yml
@@ -15,6 +15,7 @@ concurrency:
 permissions:
   contents: read
   pull-requests: read
+  checks: read

 env:
   TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
@@ -92,6 +93,23 @@ jobs:
             fi
           done
           exit $ng
+      - name: Check guardrail results
+        if: steps.pending.outputs.ansible == 'true'
+        env:
+          GH_TOKEN: ${{ github.token }}
+        run: |
+          ng=0
+          for name in ansible-lint molecule; do
+            conclusion=$(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
+              "https://api.github.com/repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/check-runs?check_name=$name" \
+              | jq -r '[.check_runs[] | select(.app.slug == "github-actions")] | sort_by(.started_at) | last | .conclusion // "missing"')
+            echo "$name: $conclusion"
+            if [ "$conclusion" != "success" ]; then
+              echo "::error::$name on $GITHUB_SHA is $conclusion"
+              ng=1
+            fi
+          done
+          exit $ng

   terraform-apply:
     needs: verify
yaml ok
26:  discard:
30:      - name: Check branch
37:      - name: Discard pending approval
47:  verify:
54:      - name: Check branch
64:      - name: Read pending approval
78:      - name: Check commits came from pull requests
96:      - name: Check guardrail results
114:  terraform-apply:
120:      - name: Terraform init
123:      - name: Terraform apply (saved plan)
127:  ansible-apply:
133:      - name: Add Ansible to PATH
135:      - name: Terraform init
138:      - name: Write private key from tfstate
143:      - name: Ansible playbook
145:        run: ansible-playbook -i dynamic_inventory.py site.yml --diff
146:      - name: Remove private key
151:  clear-pending:
156:      - name: Clear pending approval
```

`jq`の`select(.app.slug == "github-actions")`は、GitHub Actionsのジョブの結果に絞るための条件です。この変更をコミットしてプッシュし、プルリクエスト（`#41`）を作成しました。

**▼ 実行結果（プルリクエスト`#41`の「GitOps Pipeline」の実行`#73`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
.github/workflows/gitops-apply.yml
base=81369eba99b9ff02f3a3d9a072fc750c381e635e
terraform=false
***=false
```

ワークフローのファイルだけの変更なので、`terraform`も`ansible`も`false`と判定され、`changes`以外のジョブは、`ansible-lint`と`molecule`を含めてすべてスキップされました。**[セクション6](#6-パス判定でチェックを絞り込む)** で整理したとおり、ワークフローのファイルの変更は、ガードレールの対象になっていません。

`#41`をマージし（マージコミット`75cd75f`）、マージの実行（「GitOps Pipeline」の`#74`）でも、`changes`以外はスキップされ、承認待ちは作られませんでした。`workflow_dispatch`のワークフローは、デフォルトブランチに入った後の内容で起動されるため、ここから先の「GitOps Apply」には、新しいステップが入っています。

### ■ 検証内容：チェックが失敗したままマージしたコミットを適用する

mainから、`changed_when`のない`shell`のタスクを加えるブランチを作ります。**[セクション6](#6-パス判定でチェックを絞り込む)** のプルリクエスト`#40`と同じ形で、ansible-lintに指摘されるタスクです。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops08-unchecked
cat > ansible/roles/common_setup/tasks/gitops08_unchecked.yml <<'EOF'
---
- name: 確認用の設定ファイルに1行を追記する（changed_whenなし）
  become: true
  ansible.builtin.shell: echo "written_by=shell" >> /etc/gitops08-unchecked.conf
EOF
cat >> ansible/roles/common_setup/tasks/main.yml <<'EOF'
- name: 確認用のタスクを読み込み
  ansible.builtin.import_tasks: gitops08_unchecked.yml
EOF
git --no-pager diff
cat -n ansible/roles/common_setup/tasks/gitops08_unchecked.yml
git add ansible/roles/common_setup/tasks/
git commit -m "GitOps第8回: チェックが失敗したままマージする確認用"
git push -u origin gitops08-unchecked
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops08-unchecked'
diff --git a/ansible/roles/common_setup/tasks/main.yml b/ansible/roles/common_setup/tasks/main.yml
index 4c50f59..e206306 100644
--- a/ansible/roles/common_setup/tasks/main.yml
+++ b/ansible/roles/common_setup/tasks/main.yml
@@ -1,3 +1,5 @@
 ---
 - name: ドリフト検知のタスクを読み込み
   ansible.builtin.import_tasks: drift_check.yml
+- name: 確認用のタスクを読み込み
+  ansible.builtin.import_tasks: gitops08_unchecked.yml
     1  ---
     2  - name: 確認用の設定ファイルに1行を追記する（changed_whenなし）
     3    become: true
     4    ansible.builtin.shell: echo "written_by=shell" >> /etc/gitops08-unchecked.conf
[gitops08-unchecked bef75c8] GitOps第8回: チェックが失敗したままマージする確認用
 2 files changed, 6 insertions(+)
 create mode 100644 ansible/roles/common_setup/tasks/gitops08_unchecked.yml
（途中省略：プッシュの表示）
```

このブランチから、プルリクエスト（`#42`）を作成しました。確認の実行（「GitOps Pipeline」の`#75`）では、`#40`と同じく、ansible-lintが`no-changed-when`で失敗し、Moleculeはスキップされました。プルリクエストの画面には失敗の印が付きましたが、そのままマージできました（マージコミット`a69cff3`）。

次の画像は、マージで起動した「GitOps Pipeline」の実行`#76`です。状態は「Failure」で、`ansible-lint`が失敗し、`molecule`はスキップされています。一方で、`ansible-check`と`record-pending`は成功しています。

![GitOps Pipelineの実行#76。プルリクエスト#42のマージで起動され、状態はFailure。ansible-lintが失敗し、moleculeとterraform-planはスキップされ、changes、ansible-check、record-pendingは成功している](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/section7-unchecked-merge-run.png)

**▼ 実行結果（`#42`のマージの「GitOps Pipeline」の実行`#76`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示、ファイルの一覧）
base=75cd75fa2adf59d4f65f4efd289db5585bfb205c
commit=a69cff376d6149fb5ce8d9541c1e8530c8a7cf15
terraform=false
***=true
```

`record-pending`は、`ansible-check`の結果を条件にしていて、ansible-lintの結果は条件にしていません。そのため、チェックが失敗したコミットについても、承認待ちが記録されました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline -2
ls -la ~/gitops-pending
cat ~/gitops-pending/base ~/gitops-pending/commit ~/gitops-pending/terraform ~/gitops-pending/ansible
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えと、オブジェクトの受信の表示）
Updating 75cd75f..a69cff3
Fast-forward
 ansible/roles/common_setup/tasks/gitops08_unchecked.yml | 4 ++++
 ansible/roles/common_setup/tasks/main.yml               | 2 ++
 2 files changed, 6 insertions(+)
 create mode 100644 ansible/roles/common_setup/tasks/gitops08_unchecked.yml
a69cff3 (HEAD -> main, origin/main) Merge pull request #42 from juehara-crypto/gitops08-unchecked
bef75c8 (origin/gitops08-unchecked, gitops08-unchecked) GitOps第8回: チェックが失敗したままマージする確認用
total 24
drwx------  2 control control 4096 Oct  8 14:16 .
drwxr-x--- 13 control control 4096 Oct  8 14:22 ..
-rw-------  1 control control    5 Oct  8 14:16 ansible
-rw-------  1 control control   41 Oct  8 14:16 base
-rw-------  1 control control   41 Oct  8 14:16 commit
-rw-------  1 control control    6 Oct  8 14:16 terraform
75cd75fa2adf59d4f65f4efd289db5585bfb205c
a69cff376d6149fb5ce8d9541c1e8530c8a7cf15
false
true
```

この状態で、「GitOps Apply」を、ブランチ「main」、破棄のチェックなしで起動しました。次の画像は、その実行`#11`です。`verify`が失敗し、ほかのジョブはスキップされています。

![GitOps Applyの実行#11。コミットa69cff3に対して手動で起動され、状態はFailure。verifyが失敗し、terraform-apply、ansible-apply、clear-pending、discardはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/section7-blocked-apply-run.png)

**▼ 実行結果（「GitOps Apply」の実行`#11`、`verify`ジョブのステップ「Check commits came from pull requests」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
a69cff376d6149fb5ce8d9541c1e8530c8a7cf15: merge of pull request #42
```

**▼ 実行結果（「GitOps Apply」の実行`#11`、`verify`ジョブのステップ「Check guardrail results」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
***-lint: failure
Error: ***-lint on a69cff376d6149fb5ce8d9541c1e8530c8a7cf15 is failure
molecule: skipped
Error: molecule on a69cff376d6149fb5ce8d9541c1e8530c8a7cf15 is skipped
Error: Process completed with exit code 1.
```

**実行コマンド**

```plaintext
ls -la ~/gitops-pending; echo "exit_code=$?"
for n in target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n sh -c 'ls -l /etc/gitops08-* 2>&1'; done
```

**▼ 実行結果**

```plaintext
total 24
drwx------  2 control control 4096 Oct  8 14:16 .
drwxr-x--- 13 control control 4096 Oct  8 14:22 ..
-rw-------  1 control control    5 Oct  8 14:16 ansible
-rw-------  1 control control   41 Oct  8 14:16 base
-rw-------  1 control control   41 Oct  8 14:16 commit
-rw-------  1 control control    6 Oct  8 14:16 terraform
exit_code=0
== target-node1
ls: cannot access '/etc/gitops08-*': No such file or directory
== target-node2
ls: cannot access '/etc/gitops08-*': No such file or directory
== target-node3
ls: cannot access '/etc/gitops08-*': No such file or directory
```

### ■ 結果

チェックが失敗したままマージしたコミット`a69cff3`は、承認ゲートの入口で止まりました。入口の2つのステップの結果は、次のとおりです。

|ステップ|確かめること|`a69cff3`の結果|
|---|---|---|
|Check commits came from pull requests（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）|プルリクエストを通ったコミットか|通る（プルリクエスト`#42`のマージ）|
|Check guardrail results（この回）|そのコミットのチェックが成功したか|止まる（`ansible-lint: failure`、`molecule: skipped`）|

`a69cff3`は、プルリクエストを通ってmainに入ったコミットです。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** の入口の確認だけであれば、そのまま適用に進んでいました。この回で加えたステップが、チェックの結果を見て止めています。

Moleculeは、ansible-lintの失敗によって動いていないため、結果は`skipped`でした。このステップは、`success`以外をすべて止めるため、動かなかったチェックも、通ったものとしては扱いません。

承認待ちは残り、操作対象には、`/etc/gitops08-unchecked.conf`は作られていません。チェックを通っていない変更は、インフラに届きませんでした。

### ■ 検証内容：止まった承認待ちを片付けて、直したコミットを適用する

止まった承認待ちは、そのままでは適用できません。まず、「GitOps Apply」を、ブランチ「main」、破棄のチェックを入れて起動し（実行`#12`）、承認待ちを破棄しました。

**▼ 実行結果（「GitOps Apply」の実行`#12`、`discard`ジョブのステップ「Discard pending approval」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
base=75cd75fa2adf59d4f65f4efd289db5585bfb205c
commit=a69cff376d6149fb5ce8d9541c1e8530c8a7cf15
terraform=false
***=true
pending approval discarded
```

承認待ちを破棄しても、指摘されたタスクはmainに残っています。このタスクを取り除くブランチを作ります。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git switch -c gitops08-unchecked-cleanup
git rm ansible/roles/common_setup/tasks/gitops08_unchecked.yml
sed -i '/- name: 確認用のタスクを読み込み/,+1d' ansible/roles/common_setup/tasks/main.yml
git --no-pager diff HEAD
cat -n ansible/roles/common_setup/tasks/main.yml
cd ansible
ANSIBLE_INVENTORY_UNPARSED_FAILED=False ansible-lint --nocolor; echo "exit_code=$?"
cd ~/iac/docker-lab-ci
git add ansible/roles/common_setup/tasks/main.yml
git commit -m "GitOps第8回: チェックが失敗したタスクを取り除く"
git push -u origin gitops08-unchecked-cleanup
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えの表示）
rm 'ansible/roles/common_setup/tasks/gitops08_unchecked.yml'
diff --git a/ansible/roles/common_setup/tasks/gitops08_unchecked.yml b/ansible/roles/common_setup/tasks/gitops08_unchecked.yml
deleted file mode 100644
index 3e3a901..0000000
--- a/ansible/roles/common_setup/tasks/gitops08_unchecked.yml
+++ /dev/null
@@ -1,4 +0,0 @@
----
-- name: 確認用の設定ファイルに1行を追記する（changed_whenなし）
-  become: true
-  ansible.builtin.shell: echo "written_by=shell" >> /etc/gitops08-unchecked.conf
diff --git a/ansible/roles/common_setup/tasks/main.yml b/ansible/roles/common_setup/tasks/main.yml
index e206306..4c50f59 100644
--- a/ansible/roles/common_setup/tasks/main.yml
+++ b/ansible/roles/common_setup/tasks/main.yml
@@ -1,5 +1,3 @@
 ---
 - name: ドリフト検知のタスクを読み込み
   ansible.builtin.import_tasks: drift_check.yml
-- name: 確認用のタスクを読み込み
-  ansible.builtin.import_tasks: gitops08_unchecked.yml
     1  ---
     2  - name: ドリフト検知のタスクを読み込み
     3    ansible.builtin.import_tasks: drift_check.yml

Passed: 0 failure(s), 0 warning(s) in 11 files processed of 13 encountered. Last profile that met the validation criteria was 'production'.
（途中省略：新しいバージョンの案内）
exit_code=0
[gitops08-unchecked-cleanup 581ffba] GitOps第8回: チェックが失敗したタスクを取り除く
 2 files changed, 6 deletions(-)
 delete mode 100644 ansible/roles/common_setup/tasks/gitops08_unchecked.yml
（途中省略：プッシュの表示）
```

このブランチから、プルリクエスト（`#43`）を作成しました。確認の実行（「GitOps Pipeline」の`#77`）では、ansible-lintとMoleculeがどちらも成功しました。マージした後（マージコミット`67a8241`）の実行`#78`でも、2つのジョブが成功し、承認待ちが記録されました。

**▼ 実行結果（`#43`のマージの「GitOps Pipeline」の実行`#78`、`record-pending`ジョブのステップ「Record pending approval」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示、ファイルの一覧）
base=a69cff376d6149fb5ce8d9541c1e8530c8a7cf15
commit=67a8241151364323fa1c36531ba6495a051a4cf1
terraform=false
***=true
```

承認待ちを破棄した後のマージなので、起点はプッシュの前のコミット`a69cff3`です。この状態で、「GitOps Apply」を、ブランチ「main」、破棄のチェックなしで起動しました。次の画像は、その実行`#13`です。`verify`、`ansible-apply`、`clear-pending`が成功し、`terraform-apply`と`discard`はスキップされています。

![GitOps Applyの実行#13。コミット67a8241に対して手動で起動され、verify、ansible-apply、clear-pendingが成功し、terraform-applyとdiscardはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/section7-passed-apply-run.png)

**▼ 実行結果（「GitOps Apply」の実行`#13`、`verify`ジョブのステップ「Check commits came from pull requests」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
67a8241151364323fa1c36531ba6495a051a4cf1: merge of pull request #43
```

**▼ 実行結果（「GitOps Apply」の実行`#13`、`verify`ジョブのステップ「Check guardrail results」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
***-lint: success
molecule: success
```

**▼ 実行結果（「GitOps Apply」の実行`#13`、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

最後に、作業用のブランチを削除し、終了時点の状態を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline -3
git branch -D gitops08-unchecked gitops08-unchecked-cleanup
git push origin --delete gitops08-unchecked gitops08-unchecked-cleanup
git branch -a
git status --short; echo "git_status_exit_code=$?"
ls -la ~/gitops-pending; echo "exit_code=$?"
for n in target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n sh -c 'ls -l /etc/gitops08-* 2>&1'; done
cd ansible
ansible-playbook -i dynamic_inventory.py site.yml --check | tail -4
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えと、オブジェクトの受信の表示）
Updating a69cff3..67a8241
Fast-forward
 ansible/roles/common_setup/tasks/gitops08_unchecked.yml | 4 ----
 ansible/roles/common_setup/tasks/main.yml               | 2 --
 2 files changed, 6 deletions(-)
 delete mode 100644 ansible/roles/common_setup/tasks/gitops08_unchecked.yml
67a8241 (HEAD -> main, origin/main) Merge pull request #43 from juehara-crypto/gitops08-unchecked-cleanup
581ffba (origin/gitops08-unchecked-cleanup, gitops08-unchecked-cleanup) GitOps第8回: チェックが失敗したタスクを取り除く
a69cff3 Merge pull request #42 from juehara-crypto/gitops08-unchecked
Deleted branch gitops08-unchecked (was bef75c8).
Deleted branch gitops08-unchecked-cleanup (was 581ffba).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops08-unchecked
 - [deleted]         gitops08-unchecked-cleanup
* main
  remotes/origin/main
git_status_exit_code=0
ls: cannot access '/home/control/gitops-pending': No such file or directory
exit_code=2
== target-node1
ls: cannot access '/etc/gitops08-*': No such file or directory
== target-node2
ls: cannot access '/etc/gitops08-*': No such file or directory
== target-node3
ls: cannot access '/etc/gitops08-*': No such file or directory
（途中省略：Pythonのインタープリターに関する警告）
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

「GitOps Apply」の3つの実行を並べると、次のとおりです。

|実行|適用しようとしたコミット|入口の確認|結果|
|---|---|---|---|
|`#11`|`a69cff3`（チェックが失敗したまま、`#42`をマージ）|`ansible-lint: failure`、`molecule: skipped`で止まる|適用されなかった。承認待ちは残った|
|`#12`|（破棄）|―|承認待ちを破棄した|
|`#13`|`67a8241`（指摘されたタスクを取り除く`#43`をマージ）|`ansible-lint: success`、`molecule: success`で通る|3台とも`changed=0`で適用し、承認待ちを削除した|

チェックの結果が、インフラに届くための条件になりました。チェックが失敗したコミットは、プルリクエストを通っていても、承認ゲートの入口で止まります。チェックが成功したコミットだけが、適用に進みます。

止まった後の戻り方は、指摘された変更を取り除くか直すかした新しいコミットを、もう一度プルリクエストとチェックに通すことでした。止まったコミットを、そのまま通す入力はありません。

終了時点では、mainは`67a8241`で、承認待ちはなく、操作対象には確認用のファイルは作られていません。

### 必須チェックとの関係

公開リポジトリや、ブランチ保護が強制されるプランであれば、ブランチ保護かルールセットで、`ansible-lint`と`molecule`を必須のチェックに指定できます。その場合、チェックが成功するまで、プルリクエストをマージできなくなります（この構成は、公式ドキュメントの記述からの説明で、実機では確認していません）。

2つの方法が止める場所は、次のように違います。

|方法|止める場所|見る対象|
|---|---|---|
|必須のチェック（標準の機能）|mainに入る前（マージ）|プルリクエストの確認の実行|
|入口の確認（この回）|インフラに適用する前（承認ゲートの入口）|適用するmainのコミット|

必須のチェックが使える場合でも、入口の確認は残す意味があります。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5で整理したとおり、ブランチ保護のルールは、既定では管理者には適用されません。また、プルリクエストの確認の実行は、その時点のmainに対するもので、マージの後のmainのコミットに対するものではありません。適用するコミットのチェックの結果を、適用の直前に確かめる入口の確認は、必須のチェックをすり抜けたコミットに対する、最後の確認になります。

### この構成の限界

入口の確認にも、届かない範囲があります。

* **承認待ちを破棄した後の変更**：入口の確認は、承認待ちの`ansible`の判定が`true`のときに動きます。この判定は、承認待ちの起点からの変更で決まります。承認待ちを破棄すると起点がなくなり、次のマージでは、そのマージの変更だけで判定されます。この検証では、破棄の後すぐに、指摘されたタスクを取り除く変更をマージしました。もし、指摘されたタスクがmainに残ったまま、`terraform/`だけを変える変更がマージされていれば、`ansible`の判定は`false`になり、ansible-lintもMoleculeも動かず、入口の確認もスキップされます。それでも、Terraformの変更をきっかけにAnsibleの本実行は動くため、指摘されたタスクが実行されることになります（この経路は、仕組みからの導出で、実機では確認していません）。破棄は、止まった承認待ちを片付ける操作であって、mainに残った変更を取り消す操作ではありません
* **ワークフローのファイル**：**[セクション6](#6-パス判定でチェックを絞り込む)** と、この回の`#41`で確認したとおり、ワークフローのファイルだけの変更では、ansible-lintもMoleculeも動きません。入口の確認そのものも、ワークフローのファイルに書かれています。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション5で整理したとおり、書き込み権限を持つ人を、インフラを操作してよい人に限るという信頼の境界が、最後の前提になります
* **チェックが見ている範囲**：入口の確認が保証するのは、チェックが成功したことまでです。**[セクション5](#5-ガードレールはすり抜けられる)** で確認したとおり、`changed_when: false`のような書き方は、2つのチェックを通ります。入口の確認は、そのコミットを止めません

次のセクションでは、Moleculeをself-hostedランナーの上で動かすときに、操作対象との間で注意が必要な点を確認します。

---

[↑ 目次に戻る](#-目次)

---

## 8. self-hostedランナー上でMoleculeを動かす

Moleculeのテスト用のコンテナが、self-hostedランナーのホストのどこに作られ、操作対象に何をするのか、テストの後に何が残るのかを、実機で確認します。

### テスト用のコンテナは、操作対象と同じDockerの上に作られる

この回のMoleculeのシナリオは、**[セクション5](#5-ガードレールはすり抜けられる)** のとおり、`community.docker`のモジュールで、ランナーのホストのDockerにテスト用のコンテナを作ります。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で導入したself-hostedランナーは、操作対象のコンテナと同じホストで動いています。テスト用のコンテナも、操作対象と同じDockerの上に作られることになります。

ホステッドランナーであれば、テスト用のコンテナは、実行のたびに用意される仮想マシンの中に作られ、実行が終わればなくなります。self-hostedランナーでは、ホストは実行をまたいで残ります。そのため、次の2つを確かめる必要があります。

* テスト用のコンテナが、操作対象のコンテナやネットワークと、名前や接続先でぶつからないか
* テストが終わった後や、途中で止まった後に、何がホストに残るか

確認は、ランナーと同じホストで、手元からMoleculeを実行して行います。

### ■ 検証内容：テスト用のコンテナの作られ方

検証の前の、操作対象のコンテナとネットワークの状態を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git status --short; echo "git_status_exit_code=$?"
docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}}' target-node1 target-node2 target-node3 tfstate-pg
docker network ls
docker ps -a --format '{{.Names}} {{.Status}}' | sort
ls -d ~/.ansible/tmp/molecule.* 2>&1
```

**▼ 実行結果**

```plaintext
git_status_exit_code=0
/target-node1 0a20acc48f6d935e9ad3f3c59489b252ec8048034f6a830426050b5c4b5c77cd 2026-10-07T21:56:07.326239322Z
/target-node2 48305fbf396cfe7eba119faec6a4f664eaa325a4295fbde7612b71d8820873a7 2026-10-07T21:56:07.28126177Z
/target-node3 6e6e1fc26bddc2621e7a8cf638b32bbd99bf3c875af52db5c023dba366c48204 2026-10-07T21:56:07.268533192Z
/tfstate-pg 1a16113f1458356bd6ade9da2bf47e04939dbd9ba065e7c06175750b323aa776 2026-10-07T21:44:26.849140752Z
NETWORK ID     NAME              DRIVER    SCOPE
241cceaae174   ansible-app-net   bridge    local
3ab348052bbc   ansible-lab-net   bridge    local
11a0e1ca52e8   bridge            bridge    local
47e376dfb913   host              host      local
00a7783fe2d3   none              null      local
target-node1 Up 17 hours
target-node2 Up 17 hours
target-node3 Up 17 hours
tfstate-pg Up 17 hours
/home/control/.ansible/tmp/molecule.3cZV.default  /home/control/.ansible/tmp/molecule.DLh_.default
```

Moleculeの作業用のディレクトリが、`~/.ansible/tmp/`の下に2つあります。`molecule.3cZV.default`は、この回のシナリオで使われているものです。`molecule.DLh_.default`は、7月の日付のファイルを含み、この回より前に、同じホストで実行したMoleculeのものです。

続いて、`molecule test`を、`--destroy never`を付けて実行します。テストの最後にテスト用のコンテナを削除しない指定で、テスト用のコンテナがどのネットワークにつながっているかを確かめるために使います。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible/roles/common_setup
NO_COLOR=1 molecule test --destroy never > /tmp/gitops08-molecule.log 2>&1; echo "exit_code=$?"
grep -n -E 'Executed|scenario test matrix' /tmp/gitops08-molecule.log
docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}' | sort
docker inspect -f '{{.Name}} {{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}' molecule-common-setup target-node1 target-node2 target-node3
docker network ls
ls -d ~/.ansible/tmp/molecule.* 2>&1
```

**▼ 実行結果**

```plaintext
exit_code=0
1:INFO     [default > discovery] scenario test matrix: dependency, cleanup, destroy, syntax, create, prepare, converge, idempotence, side_effect, verify, cleanup, destroy
（途中省略：dependency、cleanup、destroy、syntaxの結果）
41:INFO     [default > create] Executed: Successful
（途中省略：prepareの結果）
54:INFO     [default > converge] Executed: Successful
65:INFO     [default > idempotence] Executed: Successful
（途中省略：side_effect、verify、cleanupの結果）
74:INFO     [default > destroy] Executed: Successful
（途中省略：DETAILSの表示）
molecule-common-setup ansible-target:ubuntu22.04 Up 11 seconds
target-node1 35887767a57b Up 17 hours
target-node2 35887767a57b Up 17 hours
target-node3 35887767a57b Up 17 hours
tfstate-pg postgres:17 Up 17 hours
/molecule-common-setup bridge=172.17.0.3
/target-node1 ansible-lab-net=172.19.0.4
/target-node2 ansible-lab-net=172.19.0.3
/target-node3 ansible-lab-net=172.19.0.2
NETWORK ID     NAME              DRIVER    SCOPE
241cceaae174   ansible-app-net   bridge    local
3ab348052bbc   ansible-lab-net   bridge    local
11a0e1ca52e8   bridge            bridge    local
47e376dfb913   host              host      local
00a7783fe2d3   none              null      local
/home/control/.ansible/tmp/molecule.3cZV.default  /home/control/.ansible/tmp/molecule.DLh_.default
```

`--destroy never`を付けた実行でも、最後の`destroy`は`Executed: Successful`と表示されました。ただ、テスト用のコンテナは、`Up 11 seconds`のまま残っています。

テスト用のコンテナを削除し、削除の後の状態と、操作対象のコンテナを確認します。

**実行コマンド**

```plaintext
molecule destroy > /dev/null 2>&1; echo "destroy_exit_code=$?"
docker ps -a --format '{{.Names}} {{.Status}}' | sort
ls -la ~/.ansible/tmp/molecule.*/ 2>&1
docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}}' target-node1 target-node2 target-node3 tfstate-pg
rm /tmp/gitops08-molecule.log
```

**▼ 実行結果**

```plaintext
destroy_exit_code=0
target-node1 Up 17 hours
target-node2 Up 17 hours
target-node3 Up 17 hours
tfstate-pg Up 17 hours
/home/control/.ansible/tmp/molecule.3cZV.default/:
total 20
drwxrwxr-x 3 control control 4096 Oct  8 15:05 .
drwx------ 4 control control 4096 Oct  8 15:05 ..
-rw-rw-r-- 1 control control  245 Oct  8 15:04 ansible.cfg
drwxrwxr-x 2 control control 4096 Oct  8 15:05 inventory
-rw-rw-r-- 1 control control  184 Oct  8 15:05 state.yml

/home/control/.ansible/tmp/molecule.DLh_.default/:
total 24
drwxrwxr-x 3 control control 4096 Jul 20 05:54 .
drwx------ 4 control control 4096 Oct  8 15:05 ..
-rw-rw-r-- 1 control control  245 Jul 23 04:40 ansible.cfg
drwxrwxr-x 2 control control 4096 Jul 23 04:40 inventory
-rw-rw-r-- 1 control control 1612 Jul 23 04:40 molecule.yml
-rw-rw-r-- 1 control control  199 Jul 23 04:40 state.yml
/target-node1 0a20acc48f6d935e9ad3f3c59489b252ec8048034f6a830426050b5c4b5c77cd 2026-10-07T21:56:07.326239322Z
/target-node2 48305fbf396cfe7eba119faec6a4f664eaa325a4295fbde7612b71d8820873a7 2026-10-07T21:56:07.28126177Z
/target-node3 6e6e1fc26bddc2621e7a8cf638b32bbd99bf3c875af52db5c023dba366c48204 2026-10-07T21:56:07.268533192Z
/tfstate-pg 1a16113f1458356bd6ade9da2bf47e04939dbd9ba065e7c06175750b323aa776 2026-10-07T21:44:26.849140752Z
```

### ■ 結果

テスト用のコンテナと操作対象を並べると、次のとおりです。

|項目|テスト用のコンテナ|操作対象|
|---|---|---|
|名前|`molecule-common-setup`|`target-node1`〜`3`|
|イメージ|`ansible-target:ubuntu22.04`|同じイメージ（`35887767a57b`）|
|ネットワーク|`bridge`（Dockerの既定、`172.17.0.3`）|`ansible-lab-net`（`172.19.0.2`〜`4`）|
|テストの前後の変化|テストで作られ、`molecule destroy`で削除された|`Id`と起動時刻は、テストの前と同じ|

テスト用のコンテナは、操作対象と同じイメージから作られましたが、名前もネットワークも、操作対象とは別でした。Moleculeは、新しいネットワークも作っていません。テストの前後で、操作対象のコンテナは作り直されても再起動されてもいません。

名前とネットワークが別になったのは、シナリオの`molecule.yml`でコンテナの名前を`molecule-common-setup`にし、`create.yml`でネットワークを指定しなかったためです。名前が操作対象と同じであれば、`community.docker.docker_container`は、その名前のコンテナを、テスト用のコンテナとして扱うことになります（この動きは、モジュールの仕組みからの導出で、実機では確認していません）。シナリオのコンテナの名前とネットワークは、操作対象と重ならないように決める必要があります。

一方で、テスト用のコンテナを削除した後も、Moleculeの作業用のディレクトリは、ホストに残りました。中身は、Moleculeが生成した`ansible.cfg`、インベントリ、状態の記録（`state.yml`）です。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** のセクション2で確認した、チェックアウトの掃除（`git clean -ffdx`）は、リポジトリの作業ディレクトリの中だけを対象にします。ホームディレクトリの下にあるこのディレクトリは、掃除の対象になりません。7月の日付の`molecule.DLh_.default`も、残り続けているものです。

### ■ 検証内容：前の実行のコンテナが残っていたとき

ジョブが途中で止まった場合、テスト用のコンテナは、最後の`destroy`まで進まずに残ります。この状態を、`molecule converge`だけを実行して再現します。そのうえで、別の場所に複製したリポジトリから、`molecule test`を実行します。パイプラインのジョブも、手元の`~/iac/docker-lab-ci`とは別の、ランナーの作業フォルダで動くためです。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible/roles/common_setup
NO_COLOR=1 molecule converge > /dev/null 2>&1; echo "converge_exit_code=$?"
docker ps -a --format '{{.Names}} {{.Status}}' | grep molecule
docker inspect -f '{{.Name}} {{.Id}} {{.Created}}' molecule-common-setup
docker exec molecule-common-setup cat /etc/drift-check-target.conf
ls -d ~/.ansible/tmp/molecule.* 2>&1
git clone -q ~/iac/docker-lab-ci /tmp/gitops08-clone
cd /tmp/gitops08-clone/ansible/roles/common_setup
NO_COLOR=1 molecule test > /tmp/gitops08-clone.log 2>&1; echo "exit_code=$?"
grep -n -E 'Executed|TASK \[|changed:|ok:' /tmp/gitops08-clone.log
ls -d ~/.ansible/tmp/molecule.* 2>&1
docker ps -a --format '{{.Names}} {{.Status}}' | grep molecule; echo "grep_exit_code=$?"
```

**▼ 実行結果**

```plaintext
converge_exit_code=0
molecule-common-setup Up 6 seconds
/molecule-common-setup 1f6f1be91c71414875b5e1d428d7c5c3248ff0d6ce0abf2c3e3441492567516e 2026-10-08T15:08:16.409269508Z
monitored_by=ansible-drift-check
/home/control/.ansible/tmp/molecule.3cZV.default  /home/control/.ansible/tmp/molecule.DLh_.default
exit_code=0
8:WARNING  [default > dependency] Executed: 2 missing (Remove from test_sequence to suppress)
10:WARNING  [default > cleanup] Executed: Missing playbook (Remove from test_sequence to suppress)
15:TASK [Stop and remove container] ***********************************************
16:changed: [molecule-common-setup -> localhost]
20:TASK [Remove dynamic inventory file] *******************************************
21:changed: [localhost]
27:INFO     [default > destroy] Executed: Successful
（途中省略：syntaxの結果）
37:TASK [Create a container] ******************************************************
38:changed: [localhost] => (item={'image': 'ansible-target:ubuntu22.04', 'name': 'molecule-common-setup'})
（途中省略：createの残りのタスクの結果）
57:INFO     [default > create] Executed: Successful
（途中省略：prepareの結果）
64:TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
65:changed: [molecule-common-setup]
70:INFO     [default > converge] Executed: Successful
75:TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
76:ok: [molecule-common-setup]
81:INFO     [default > idempotence] Executed: Successful
（途中省略：side_effect、verify、cleanupの結果）
92:TASK [Stop and remove container] ***********************************************
93:changed: [molecule-common-setup -> localhost]
（途中省略：インベントリの削除の結果）
104:INFO     [default > destroy] Executed: Successful
（途中省略：DETAILSの表示）
/home/control/.ansible/tmp/molecule.3cZV.default  /home/control/.ansible/tmp/molecule.DLh_.default
grep_exit_code=1
```

複製したリポジトリを片付け、元のリポジトリから見たMoleculeの記録と、終了時点の状態を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible/roles/common_setup
molecule list 2>&1 | tail -5
NO_COLOR=1 molecule destroy > /dev/null 2>&1; echo "destroy_exit_code=$?"
rm -rf /tmp/gitops08-clone /tmp/gitops08-clone.log
ls -d ~/.ansible/tmp/molecule.* 2>&1
cd ~/iac/docker-lab-ci
git status --short; echo "git_status_exit_code=$?"
docker ps -a --format '{{.Names}} {{.Status}}' | sort
docker network ls
docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}}' target-node1 target-node2 target-node3 tfstate-pg
```

**▼ 実行結果**

```plaintext
                        ╷             ╷                  ╷               ╷         ╷
  Instance Name         │ Driver Name │ Provisioner Name │ Scenario Name │ Created │ Converged
╶───────────────────────┼─────────────┼──────────────────┼───────────────┼─────────┼───────────╴
  molecule-common-setup │ default     │ ansible          │ default       │ false   │ false
                        ╵             ╵                  ╵               ╵         ╵
destroy_exit_code=0
/home/control/.ansible/tmp/molecule.3cZV.default  /home/control/.ansible/tmp/molecule.DLh_.default
git_status_exit_code=0
target-node1 Up 17 hours
target-node2 Up 17 hours
target-node3 Up 17 hours
tfstate-pg Up 17 hours
NETWORK ID     NAME              DRIVER    SCOPE
241cceaae174   ansible-app-net   bridge    local
3ab348052bbc   ansible-lab-net   bridge    local
11a0e1ca52e8   bridge            bridge    local
47e376dfb913   host              host      local
00a7783fe2d3   none              null      local
/target-node1 0a20acc48f6d935e9ad3f3c59489b252ec8048034f6a830426050b5c4b5c77cd 2026-10-07T21:56:07.326239322Z
/target-node2 48305fbf396cfe7eba119faec6a4f664eaa325a4295fbde7612b71d8820873a7 2026-10-07T21:56:07.28126177Z
/target-node3 6e6e1fc26bddc2621e7a8cf638b32bbd99bf3c875af52db5c023dba366c48204 2026-10-07T21:56:07.268533192Z
/tfstate-pg 1a16113f1458356bd6ade9da2bf47e04939dbd9ba065e7c06175750b323aa776 2026-10-07T21:44:26.849140752Z
```

### ■ 結果

`molecule converge`で残したテスト用のコンテナは、ロールを適用した状態（`monitored_by=ansible-drift-check`）で、テストの外に残りました。ジョブが途中で止まれば、テスト用のコンテナは、次にMoleculeを実行するまで、ホストで動き続けることになります。

複製したリポジトリの`molecule test`では、次のように進みました。

|フェーズ|タスク|結果|
|---|---|---|
|最初の`destroy`|Stop and remove container|`changed`。残っていたコンテナを削除した|
|`create`|Create a container|`changed`。新しいコンテナを作った|
|`converge`|ドリフト検知の実演用設定ファイルを配置|`changed`。新しいコンテナに適用した|
|`idempotence`|同じタスク|`ok`|
|最後の`destroy`|Stop and remove container|`changed`|

別の場所に複製したリポジトリから実行しても、Moleculeの作業用のディレクトリは増えず、同じ`molecule.3cZV.default`が使われました。そのため、複製した側の最初の`destroy`は、元のリポジトリの実行が残したコンテナを、自分の記録にあるコンテナとして削除しました。その後に新しいコンテナを作っているため、前の実行のコンテナが、次のテストに使い回されることはありませんでした。元のリポジトリの`molecule list`も、複製した側の削除を受けて、`Created`が`false`になっています。

`molecule test`の流れが、最初に`destroy`を実行するのは、前の実行の残りを片付けるためと読めます。この回の構成では、実行する場所が違っても同じ記録が使われたため、その片付けが効きました。

一方で、同じ記録とコンテナの名前を共有していることは、別の実行同士がぶつかりうることも意味します。パイプラインのジョブ同士は、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** の`concurrency`で直列化されているため重なりません。しかし、パイプラインのMoleculeが動いている間に、同じホストで手元からMoleculeを実行すれば、手元の最初の`destroy`が、パイプラインのテスト用のコンテナを削除するおそれがあります（この経路は、この検証の結果と仕組みからの導出で、実機では確認していません）。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** のセクション5で、Ansibleには手元からの実行を止める仕組みがないと整理したのと、同じ構造です。

### ランナーが触れる範囲

ここまでの結果を、self-hostedランナーで動かすときの注意として並べると、次のとおりです。

|注意すること|この回の構成|
|---|---|
|テスト用のコンテナの名前|`molecule-common-setup`にし、操作対象の`target-node1`〜`3`と重ならないようにした|
|テスト用のコンテナのネットワーク|指定せず、Dockerの既定の`bridge`につないだ。操作対象の`ansible-lab-net`にはつながない|
|テストの後のコンテナ|`molecule test`の最後の`destroy`で削除される。途中で止まった場合は、次の実行の最初の`destroy`で削除された|
|Moleculeの作業用のディレクトリ|ホームディレクトリの下に残り、チェックアウトの掃除の対象にならない|
|手元からの実行|パイプラインと同じ記録とコンテナの名前を使うため、重なるとぶつかりうる|

もう1つ、ランナーの権限の問題があります。Moleculeのジョブは、ランナーのホストのDockerを操作して、テスト用のコンテナを作ります。この権限は、テスト用のコンテナに限られたものではなく、同じホストの操作対象のコンテナも操作できる権限です。プルリクエストのシナリオのファイル（`create.yml`や`destroy.yml`）を書き換えれば、プルリクエストの確認の実行の中で、操作対象のコンテナを操作するPlaybookを動かせることになります（この経路は、仕組みからの導出で、実機では確認していません）。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション6で、ランナーでコードを実行できる人は、インフラを操作できる人だと整理しました。Moleculeを同じホストで動かすことで、この前提は、承認ゲートを通さないプルリクエストの確認の段階にも及びます。

次のセクションでは、Moleculeのテストが、何を保証し、何を保証しないのかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 9. Moleculeが保証する範囲

Moleculeのテストが、何を保証し、何を保証しないのかを、実際の操作対象に対する確認と並べて整理します。

### Moleculeが試しているもの

**[セクション5](#5-ガードレールはすり抜けられる)** と **[セクション8](#8-self-hostedランナー上でmoleculeを動かす)** で確認したとおり、この回のMoleculeのシナリオは、次のように動きます。

* 操作対象と同じイメージ（`ansible-target:ubuntu22.04`）から、テスト用のコンテナを新しく作る
* `converge.yml`で、ロール`common_setup`だけを適用する
* 同じロールを2回適用し、2回目に`changed`が出ないことを確かめる
* テストが終わったら、テスト用のコンテナを削除する

つまり、Moleculeが試しているのは、「ロール単体を、新しく作った環境に適用したときに、収束するか」です。

### 実際の操作対象との違い

一方、パイプラインがインフラに適用するときは、実際の操作対象に対して、`site.yml`を実行します。2つの間には、次の違いがあります。

|項目|Moleculeのテスト|実際の操作対象への適用|
|---|---|---|
|対象|実行のたびに新しく作るテスト用のコンテナ1台|実行をまたいで動き続ける`target-node1`〜`3`|
|接続の方法|Dockerの接続（`community.docker.docker`）|SSH。鍵は、ジョブの中でtfstateの出力から書き出す（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**）|
|インベントリ|Moleculeが作る`molecule`のグループ|`dynamic_inventory.py`がtfstateから作る`target_nodes`のグループ|
|接続するユーザー|コンテナの既定のユーザー|`ansible`のユーザーで接続し、`become`で権限を上げる（**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション3）|
|実行するもの|ロール`common_setup`だけ|`site.yml`（疎通確認のタスクと、ロール`common_setup`）|
|適用する前の状態|何も適用されていない|前回までの適用の結果と、Gitを経由しない変更が残っている状態|

Moleculeのテストが成功しても、実際の操作対象でSSHの接続に使う鍵や、インベントリの作り方、`become`による権限の昇格は、試されていません。また、実際の操作対象は、新しく作った環境ではありません。前回までの適用の結果や、手動の変更が残った状態に対して、Playbookが実行されます。

### 実際の操作対象は、確認モードと本実行で確かめる

この違いを埋めているのは、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** までに組んだ、実際の操作対象に対する確認と適用です。3つを並べると、次のとおりです。

|確認|対象|確かめること|限界|
|---|---|---|---|
|Molecule（この回）|新しく作ったテスト用のコンテナ|ロール単体が、新しい環境で収束するか|実際の操作対象との組み合わせは試さない。`changed`の報告を変える書き方は通る（**[セクション5](#5-ガードレールはすり抜けられる)**）|
|`ansible-check`（`--check --diff`、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）|実際の操作対象|今の状態に対して、適用で何が変わるか|予測にとどまる。`shell`や`command`のタスクはスキップされる（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4）|
|`ansible-apply`（本実行、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）|実際の操作対象|―|承認の後に、実際に変える|

`ansible-check`は、`dynamic_inventory.py`で実際の操作対象のインベントリを作り、tfstateから書き出した鍵でSSHの接続をして、`site.yml`を確認モードで実行します。Moleculeが試さない接続とインベントリと、実際の操作対象の今の状態は、ここで確かめられています。**[セクション6](#6-パス判定でチェックを絞り込む)** で、Terraformだけの変更ではMoleculeを動かさず、`ansible-check`は動かす構成にしたのは、この役割の分担のためです。Terraformの変更が影響するのは、接続先やインベントリの側で、ロール単体の動きではありません。

Moleculeは「ロールが収束するか」を、`ansible-check`は「実際の操作対象で何が変わりそうか」を確かめています。どちらか一方では、もう一方の代わりになりません。

### このシナリオが確かめていないこと

この回のシナリオには、ほかにも確かめていないことがあります。

* **あるべき状態になったか**：シナリオには`verify.yml`を用意していないため、`verify`のフェーズは`Missing playbook`で、何も確かめていません。Moleculeシリーズの **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-04/)** で整理した4つ目の失敗の型、「収束はするが、あるべき状態になっていない」は、このシナリオでは見つけられません。この回のMoleculeは、収束するかを確かめるガードレールとして使っています
* **ほかのロール**：パイプラインの`molecule`ジョブは、作業ディレクトリをロール`common_setup`に固定しています。ロールを増やしたときは、そのロールのシナリオと、ジョブでの実行を加える必要があります。加えなければ、新しいロールは、ansible-lintだけを通ってインフラに届きます
* **環境の違いによる動きの違い**：テスト用のコンテナは、操作対象と同じイメージから作っています。冪等性シリーズの **[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-07/)** で整理したように、OSやPythonの違いによって、モジュールの動きは変わりえます。同じイメージを使うことで、この違いを小さくしていますが、操作対象のイメージが変わったときは、シナリオのイメージも合わせる必要があります

Moleculeが保証するのは、ロール単体が、新しい環境で収束することです。実際の操作対象での動きは、`--check --diff`による予測と、承認の後の本実行で確かめます。ガードレールは、その手前で、収束しないロールや、承認の材料に現れないタスクを止めるための段階です。

次のセクションでは、操作対象がクラウドの仮想マシンの場合に、このガードレールがどう変わるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 10. クラウドの操作対象でもガードレールは変わらない

この回で組んだガードレールを、操作対象がAWSやGCPの仮想マシンの場合に当てはめると、何が変わり、何が変わらないかを整理します。クラウドでの実行は行っていないため、ここでは、この回の構成と、**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)**・**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で整理した内容を並べて比べます。

### ガードレールは、操作対象に触れない

この回の2つのチェックは、どちらも実際の操作対象に接続しません。

* ansible-lintは、リポジトリのファイルを読むだけで、Playbookを実行しない（**[セクション3](#3-ansible-lintで承認の材料から漏れるタスクを見つける)**）
* Moleculeは、ランナーのDockerの上に作ったテスト用のコンテナにだけ、ロールを適用する（**[セクション8](#8-self-hostedランナー上でmoleculeを動かす)**）

そのため、操作対象がAWS EC2やGCP Compute Engineの仮想マシンに変わっても、2つのチェックの動かし方は変わりません。マージの前に、クラウドの仮想マシンを作らずに、コンテナの上で同じ確認ができます。クラウドの費用も、仮想マシンの起動を待つ時間もかかりません。

**[セクション7](#7-適用前にチェック結果を確認する)** の入口の確認も、GitHubに残るジョブの結果を読むもので、プロバイダーには関係しません。

|設計|操作対象をクラウドの仮想マシンにしたとき|
|---|---|
|ansible-lintによる静的なチェック（**[セクション3](#3-ansible-lintで承認の材料から漏れるタスクを見つける)**）|変わらない|
|Moleculeによる冪等性テスト（**[セクション5](#5-ガードレールはすり抜けられる)**）|コンテナの上で動かせる。ただし、操作対象との環境の差が大きくなる（後述）|
|パス判定と、ansible-lintを先に動かす構成（**[セクション6](#6-パス判定でチェックを絞り込む)**）|変わらない。GitHub Actionsのワークフローの構成|
|適用の入口でのチェックの結果の確認（**[セクション7](#7-適用前にチェック結果を確認する)**）|変わらない。GitHubのAPIで、ジョブの結果を読む|
|`changed_when: false`によるすり抜け（**[セクション5](#5-ガードレールはすり抜けられる)**）|変わらない。ansible-lintとMoleculeの判定の仕組み|

### Moleculeを動かす場所を、操作対象から離せる

**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション7で整理したとおり、クラウドでは、Ansibleの接続先（VPCのプライベートサブネットの仮想マシン）に届くよう、self-hostedランナーを同じVPCの中に置く必要があります。一方、Moleculeは、実際の操作対象に接続しません。Moleculeのジョブだけは、操作対象に届かない場所で動かしても成り立ちます。

この点は、**[セクション8](#8-self-hostedランナー上でmoleculeを動かす)** で整理したランナーの権限の問題にも関わります。この検証環境では、Moleculeがテスト用のコンテナを作るDockerと、操作対象が動くDockerが同じでした。クラウドの構成で、Moleculeのジョブを、操作対象に届かないランナー（たとえば、**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で比べたホステッドランナー）で動かせば、プルリクエストのシナリオのファイルから、操作対象に触れる経路はなくなります。その場合は、テスト用のコンテナのイメージを、そのランナーで用意できるようにする必要があります（この構成は、仕組みからの導出で、実機では確認していません）。

### コンテナでは確かめられないもの

一方で、コンテナと仮想マシンでは、Playbookが触れる環境に差があります。**[セクション9](#9-moleculeが保証する範囲)** で整理したとおり、Moleculeが保証するのは、ロール単体が、テスト用の環境で収束することです。テスト用の環境が操作対象と違うほど、保証の範囲は狭くなります。

|項目|この検証環境|クラウドの仮想マシン|
|---|---|---|
|テスト用の環境と操作対象の関係|同じイメージ（`ansible-target:ubuntu22.04`）から作る|操作対象はマシンイメージ（AWSのAMI、GCPのマシンイメージ）から起動し、テスト用のコンテナはコンテナのイメージから作るため、出どころが別になる|
|プロセスの管理|操作対象もコンテナで、`sshd`を直接起動していて、systemdは動いていない（**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション3）|仮想マシンでは、systemdがサービスを管理する|
|起動時の初期設定|`upload`で、公開鍵などを置く|`user_data`や`startup-script`で、cloud-initなどが初期設定を行う（**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション6）|

たとえば、`ansible.builtin.systemd`や`ansible.builtin.service`でサービスを起動・再起動するタスクは、systemdが動いていない通常のコンテナでは、仮想マシンと同じようには試せません。Moleculeシリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-molecule/ansible-molecule-02/)** で対象にしたPlaybookも、ハンドラーでnginxを`systemd`のモジュールでリロードしていて、既存のノードを対象にテストしていました。カーネルのパラメーターや、マウント、クラウドのメタデータに依存するタスクも、コンテナの上では、仮想マシンと同じ結果になるとは限りません。

この差を埋める方法は、2つの方向があります（どちらも、この回では確認していません）。

* テスト用の環境を、操作対象に近づける。systemdを動かすコンテナを使う、あるいは、Moleculeでクラウドの仮想マシンを作ってテストする。後者は、コンテナで動かす利点（費用と時間）を手放すことになる
* コンテナで確かめられない部分は、**[セクション9](#9-moleculeが保証する範囲)** で整理したとおり、実際の操作対象に対する`--check --diff`と、承認の後の本実行で確かめる

コンテナの上のMoleculeは、操作対象がどこにあっても、マージの前に動かせるガードレールです。ただし、操作対象が仮想マシンになるほど、コンテナが試せる範囲と、操作対象で実際に起きることの差は広がります。ガードレールの成功は、コンテナで試せた範囲での成功です。

次のセクションでは、この回で確認した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 11. まとめ

この回で整理した内容を確認します。

* ansible-lintとMoleculeは、Playbookの品質を見るチェックとしてではなく、パイプラインの前提を守るガードレールとして位置づけられる。ansible-lintは、承認の材料から適用で何が変わるかを予測できる、という前提を守り、Moleculeの冪等性テストは、何度実行しても同じ状態に収束する、という前提を守る。`state: latest`は、同じ時点の2回の実行では収束するため、Moleculeでは止められず、書かれた内容を見るansible-lintだけが実行の前に見つけられる
* ansible-lint 26.6.0で、承認の材料に現れない`shell`のタスクが`no-changed-when`で、`state: latest`が`package-latest`で指摘されることを実機で確認した。バージョンを指定しない`state: present`は指摘されず、ansible-lintが見ているのは書かれた値で、あるべき状態がPlaybookの中で閉じているかではない。また、今のmainがansible-lintを通らず、権限の指定がない`copy`のタスクに加えて、第5回で入れた`unparsed_is_failed`が構文の確認とぶつかっていることを確認し、ansible-lintを実行するときだけ環境変数で上書きする形にした
* ずれの検知と自動収束は、収束した状態に対してPlaybookを実行すれば`changed`は0になる、という前提に立つ。収束しないPlaybookが載ると、存在しないずれを直し続け、本物のずれも埋もれる。Moleculeの冪等性テストは、この前提を、検知の仕組みとは別の場所で、マージの前に確かめる
* `changed_when: false`を付けて1行を追記する`shell`のタスクは、ansible-lintも、Moleculeの冪等性テストも通り、その間にテスト用のコンテナのファイルは2行に増えていたことを実機で確認した。2つのチェックは、どちらも`changed_when`の有無や`changed`の報告という表示を見ていて、状態を宣言する`copy`の`ok`と、表示を変えただけの`ok`を区別できない。ガードレールを通すことと、冪等であることは別である
* ansible-lintとMoleculeを、`ansible/`に変更があるときだけ動くジョブとしてパイプラインに組み込み、ansible-lintを独立したジョブとしてMoleculeの前に置いた。ansible-lintは20秒前後、Moleculeは44秒で、ansible-lintが失敗したときはMoleculeが動かず、どちらで止まったかがジョブの名前で分かることを実機で確認した。Terraformだけの変更や、ワークフローのファイルだけの変更では、2つのジョブは動かない
* チェックが失敗したプルリクエストも、この検証環境ではマージでき、承認待ちも記録された。承認ゲートの入口に、適用するmainのコミットに対する`ansible-lint`と`molecule`の結果を、GitHubのAPIで確かめるステップを加えた。チェックが失敗したままマージしたコミットは、プルリクエストを通っていても入口で止まり、指摘されたタスクを取り除いてチェックを通したコミットだけが適用まで進むことを実機で確認した。承認待ちを破棄した後の変更やワークフローのファイルは、この確認の外に残る
* self-hostedランナーの上のMoleculeは、操作対象と同じDockerにテスト用のコンテナを作る。コンテナの名前と、つなぐネットワークを操作対象と分けたことで、テストの前後で操作対象は変わらなかった。テストの後もMoleculeの作業用のディレクトリはホストに残り、別の場所から実行しても同じものが使われたため、途中で残ったコンテナは次の実行の最初の`destroy`で片付いた。同じ記録を使うことは、手元とパイプラインの実行がぶつかりうることも意味し、Moleculeのジョブは操作対象も操作できるDockerの権限を持つ
* Moleculeが保証するのは、ロール単体が、新しく作ったテスト用の環境で収束することである。接続の方法、インベントリ、権限の昇格、前回までの適用の結果が残った状態との組み合わせは、実際の操作対象に対する`--check --diff`と、承認の後の本実行で確かめる。このシナリオは`verify`を持たず、あるべき状態になったかは確かめていない
* ansible-lintとMoleculeは、どちらも操作対象に接続しないため、操作対象がAWSやGCPの仮想マシンでも、マージの前にコンテナの上で動かせる。ただし、マシンイメージとコンテナのイメージ、systemdの有無、起動時の初期設定など、仮想マシンとの差が広がるほど、コンテナで試せる範囲は狭くなる

---

[↑ 目次に戻る](#-目次)

---

## 12. 次回予告

本シリーズの **[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、適用系を手動の起動に分離し、保存したplanと、そのplanを作ったコミットのPlaybookだけが、人の承認を経て適用される承認ゲートを組みました。第8回となる今回は、その承認の手前に、ansible-lintとMoleculeをガードレールとして置きました。2つのチェックが、承認の材料から予測できることと、何度実行しても収束することという、パイプラインの前提を守るものであることを整理し、ansible-lintが承認の材料に現れないタスクを実行の前に指摘することを実機で確認しました。`changed_when: false`のように表示を変えるだけの書き方で、2つのチェックをすり抜けられることも確かめました。そのうえで、パス判定でチェックを絞り込み、承認ゲートの入口でチェックの結果を確かめて、チェックが失敗したままマージしたコミットが適用の前に止まることを実機で確認しました。最後に、self-hostedランナーの上でMoleculeを動かすときの注意、Moleculeが保証する範囲、クラウドの操作対象での扱いを整理しました。

この回で、Ansibleの側には、人の承認の手前で機械的に止めるガードレールが置かれました。一方、Terraformの側は、まだ承認する人がplanを読むことに頼っています。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** で確認したとおり、`main.tf`だけの小さな変更でも、コンテナの作り直し（`must be replaced`）が起き、Ansibleで投入した設定が失われることがあります。その作り直しや削除がplanに含まれていても、それを機械的に見つけて止める仕組みは、まだありません。

**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** では、同じ考え方で、Terraformの側にもガードレールを置きます。コードに対する静的なチェックと、planに対するポリシーのチェックの2層を整理し、planから作り直しや削除を読み取って、Ansibleの設定の消失を適用の前に扱う構成を作ります。ツールの両側にガードレールをそろえ、それぞれが止められないものも示します。

**[次回：第9回：Terraform側にもガードレールを置く](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)　｜　[次の記事：【GitOps編】第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第2部まとめブログ：GitOpsパイプラインで「見たものだけが、承認したときだけ届く」仕組みを積み上げる** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 13. 連載一覧：「Ansible×TerraformをGitOpsで回す」

### 第1部：GitOpsの基本概念とAnsibleとの接続

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)**|なぜ「Gitがインフラの唯一の真実」なのか|GitOpsの4原則を評価軸として、AnsibleとTerraformの充足度を整理する。push型構成の立ち位置と、「唯一の真実」が崩れる3つの経路を示す。|
|**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)**|AnsibleとTerraformのGitOps上での責務分担|責務分担を「変更の種類ごとに必要な実行」として捉え直す。変更の3分類、境界が曖昧な設定の判定基準、Gitの外にある接続面を整理する。|
|**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)**|GitリポジトリとAnsibleの構造設計|変更の分類をパスで表現するディレクトリ構成、Gitに置くもの・置かないもの、モノレポとマルチリポの選択基準、mainを唯一の真実とするブランチ運用を設計する。無料プランの非公開リポジトリでは直接プッシュを防げないため、強制する場所を適用前に移す方針を示す。|
|**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)**|ローカルGitea vs GitHub Actionsの選択基準|到達性・状態の永続性・機密情報の置き場所・運用負荷の4基準で比較し、選択が信頼境界の要件で決まることを示す。本シリーズはGitHub＋self-hostedランナーを採用し、リポジトリを非公開で運用する。第1部の最終回。|

### 第2部：GitHub Actionsによる自動化パイプライン

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**|GitHub ActionsからAnsibleを実行する基本構成|プルリクエストで確認、マージで適用という基本フローを実装する。変更されたパスによるジョブの切り替え、Terraform→Ansibleの実行順序の保証、実行時のインベントリの生成を扱い、AWS・GCPプロバイダーへの書き換え点を示す。第2部の初回。|
|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**|tfstateの管理とパイプラインの同時実行|self-hostedランナー上でtfstateが消える問題と置き場所の設計、連続マージや手動実行との同時実行を扱う。Terraformのstateロックとパイプラインの直列化による二重の保護を設計し、Ansibleにはロックがないという非対称性を示す。|
|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**|planのレビューと承認ゲート|レビューしたplanと実際に適用される内容のずれ、保存したplanの適用、`--check --diff`で承認者に見えない変更を扱う。無料プランの非公開リポジトリでも動く、手動起動による承認ゲートを設計する。「プッシュのたびにインフラが変わる恐怖」への回答となる回。|
|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**|GitOpsの品質ガードレールとしてMoleculeとansible-lintを組み込む|Moleculeシリーズ第4回の「確認し続ける仕組み」の次の段階として、確認結果を「インフラに届くための条件」にする。適用前にチェック結果を確認する構成と、`changed_when: false`によるすり抜けという限界を示す。|
|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**|Terraform側にもガードレールを置く|コードに対する静的チェックと、planに対するポリシーチェックの2層を整理する。planから再生成・削除を検知し、Ansibleの設定消失を適用前に扱う3ツール統合ならではのガードレールを作る。|
|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|複数環境（dev/stg/prod）へのデプロイを分岐させる|環境をブランチではなく、mainの1本と環境別ディレクトリで分ける。tfstate・インベントリ・承認を環境ごとに分け、昇格の順序と条件をワークフローで強制する。「最後に適用したコミット」の記録を導入する。|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**|git revertしてもOSは戻らない：ロールバックの非対称性|宣言型のTerraformはrevertで戻るが、手続き型のAnsibleは入れた設定が残るという非対称性を実機で示す。GitOpsのロールバックをロールフォワードとして整理し、revertの残骸が検知できないことを示す。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**|失敗したパイプラインをどう診断するか|パイプラインの失敗をGitHub Actions・ガードレール・Terraform・Ansibleの4層に分け、「設計どおりの停止か、故障か」を切り分ける。Ansible×Terraformシリーズ第3部の知識を活用する。第2部の最終回。|

---

[↑ 目次に戻る](#-目次)

---