---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第17回：GitOps環境でドリフトはなぜ起きるのか'
description: 'Gitに通した変更だけでインフラを動かしていても、実際の状態がGitの定義から離れていく理由を整理する。「記述・記録されていないものは見えない」というルールが、Ansible・Terraform・GitOpsの3か所で同じ形で現れることを示し、第1回で示した3つの経路が第2部・第3部を経てどう残ったかと、承認・昇格・revertが新たに生む食い違いを確かめる。「main」「最後に適用したコミット」「実環境」の3つの状態を区別し、マージ済みで未適用の状態と、リソースの属性の手動変更を実機で作って、未適用の差分とドリフトを記録で見分ける。第4部の初回。'
pubDate: 2026-10-21
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'ドリフト', '構成管理']
seriesId: 'ansible-gitops-part4'
seriesNo: 17
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>


> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第4部まとめブログ：ドリフトの区別・検知・収束・例外・予防を「最後に適用したコミット」でつなぐ** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [1つのルールが3か所で現れる](#2-1つのルールが3か所で現れる)
3. [3つの経路は塞がったか](#3-3つの経路は塞がったか)
4. [GitOps自身が生む乖離](#4-gitops自身が生む乖離)
5. [3つの状態で乖離を分ける](#5-3つの状態で乖離を分ける)
6. [ドリフトを記録で見分ける](#6-ドリフトを記録で見分ける)
7. [検出できるドリフトと検出できないドリフト](#7-検出できるドリフトと検出できないドリフト)
8. [クラウドでも同じルールが働く](#8-クラウドでも同じルールが働く)
9. [まとめ](#9-まとめ)
10. [次回予告](#10-次回予告)
11. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#11-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

TerraformとAnsibleのコードをGitで管理し、GitHub Actionsのパイプラインで適用していて、

* 変更はすべてプルリクエストに通し、承認ゲートとガードレールも入れた
* パイプラインの実行は、すべて成功している
* よって、実際のインフラは、Gitに書いたとおりの状態になっている

と考えていないでしょうか。

GitOpsでドリフトを扱う記事の多くは、Argo CDやFluxのようなpull型の構成を前提に、管理対象の側で常駐するエージェントが、ずれを自動で戻すと説明しています。CIから変更を押し込むpush型の構成で、Gitに通す仕組みを積み上げた後に、ずれがどこに残るのかは、あまり扱われていません。AnsibleとTerraformのパイプラインを運用していると、次のような場面にぶつかります。

* パイプラインの実行はすべて成功しているのに、実際のインフラの設定がGitと違う
* mainにマージした変更がprodに入っていないのを見て、ドリフトだと思い込んだ
* revertした後も、足したものが残っていて、どの確認でも検出されない
* `terraform plan`も`ansible-playbook --check`も差分なしなのに、設定が違っている

これらは、パイプラインの不具合や、確認の漏れに見えます。共通しているのは、Gitに書いたあるべき状態、実際に適用した状態、実際のインフラの状態を1つのものとして扱い、それぞれのツールが、何と何を比べているのかを区別していない点です。

ドリフトは、**[「Ansibleは冪等なのに、なぜサーバは壊れていくのか」](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)**（以下、ドリフトシリーズ）で扱ってきました。

|回|扱った内容|
|---|---|
|**[ドリフトシリーズ第0回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-00/)**|冪等性とドリフトが、別の問題であることを整理した|
|**[ドリフトシリーズ第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)**|手動で変えた設定が、`template`と`lineinfile`で、再実行の結果が分かれることを確かめた|
|**[ドリフトシリーズ第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)**|`--check`で問題が出ないことが、ずれがないことの証明にならないことを確かめた|
|**[ドリフトシリーズ第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-03/)**|`changed`が出ないまま、cronや自動更新で設定が書き換わっていくことを確かめた|
|**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)**|ドリフトを仕組みで扱うために、防ぐ・検知する・修正するという3つの観点で設計を整理した|

**[ドリフトシリーズ](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)** 第1回〜第3回で確かめたことは、どれも、Ansibleが比べるのはタスクに記述されている要素だけで、記述されていない要素は比較の対象にならない、という1つのルールから起きています。

AnsibleとTerraformを組み合わせた構成は、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）で扱ってきました。

|回|扱った内容|
|---|---|
|**[Ansible×Terraformシリーズ第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)**|スケジュール実行で`ansible-playbook --check`を流し、差分があった場合にだけ本実行して、自動で収束させる仕組みを作った。ただし、実行のたびに使い捨てられるホステッドランナーからは、常時動いているインフラを外から見られないため、コンテナの起動から改ざんの注入、検知までを、1回のワークフローの実行の中で完結させる構成だった|
|**[Ansible×Terraformシリーズ第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)**|tfstateに記録されているのは、イメージ、ポート、ネットワークといったリソースの属性で、コンテナの中にファイルを作っても`terraform plan`は「No changes」になる一方、`restart`のような属性の変更は差分として検出されることを確かめた|

本シリーズでは、これまでの回で、次の整理と仕組みを積み上げてきました。

|部|回|扱った内容|
|---|---|---|
|第1部|**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)**（セクション6）|「Gitが唯一の真実」が崩れる経路を、① Gitを経由しない手動変更、② tfstateの観測範囲外で起きる変化、③ 収束処理が走らない期間の放置、の3つに整理した。Playbookのどのタスクにも書かれていないファイルの変更は、Git、Terraform、Ansibleのいずれも検出せず、「Gitが唯一の真実」と言えるのは、Gitに記述されている範囲の中だけだとした|
|第1部|**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)**（セクション7）|①は第2部で減らせても、なくすことはできず、残った手動変更と、②・③は、第4部で扱うとした|
|第2部|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**|適用を手動で起動する承認ゲートを作った|
|第2部|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|mainの1つのコミットを、dev、stg、prodの順にしか適用できない昇格の仕組みを作り、環境ごとに「最後に適用したコミット」を記録した|
|第2部|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**|`git revert`で戻るのは、revertの後のコードに元の状態が書かれているものだけで、足したものはrevertしても残ることを確かめた|
|第3部|第13回〜第16回|機密情報を「Gitの中はVault、Gitの外は鍵」の2層で扱い、漏れたとき、失われたときの入れ替えまでを、パイプラインに通した|

第2部（第5回〜第12回）では、変更がGitを通って初めてインフラに届くパイプラインを作り、第3部では、その中で機密情報も扱えるようにしました。どれも、パイプラインを通る変更を扱う仕組みです。しかし、操作対象は、パイプラインの外からも変わります。

第4部（第17回〜第21回）では、**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** の防ぐ・検知する・修正するを、GitOpsのパイプラインの上で組み立てます。第17回となる今回は、その前提として、GitOpsの環境に残るドリフトの全体像を整理します。まず、記述されていない要素は比較の対象にならないというドリフトシリーズのルールが、Ansibleだけでなく、Terraformと、GitOpsの適用の記録にも、同じ形で現れることを整理します。次に、本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** の3つの経路が、第2部・第3部の仕組みを入れた後にどうなったかを確かめ、承認、昇格、revertというGitOpsの仕組みそのものが、新しい食い違いを生むことを示します。そのうえで、「main」「最後に適用したコミット」「実環境」の3つの状態を区別し、マージ済みで未適用の状態を実機で作って、承認や昇格を待っているだけの未適用の差分が、ドリフトと同じ形で表示されることを確かめます。続けて、Terraformが管理するリソースの属性を手で変え、最後に適用したコミットの記録と照らし合わせることで、それがドリフトだと判断できることを確かめます。さらに、Terraformの`plan`とAnsibleの`--check`で検出できる範囲と、どちらでも検出できない範囲を整理します。最後に、この整理が、クラウドのプロバイダーでも変わらないことを示します。

なお、第4部は、ドリフトシリーズと、**[Ansible×Terraformシリーズ第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** ・ **[Ansible×Terraformシリーズ第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** と内容的なつながりがあります。**[ドリフトシリーズ](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)** がAnsibleの比べる範囲を、**[Ansible×Terraformシリーズ第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** が1回のワークフローの実行の中で完結する検知と収束を、**[Ansible×Terraformシリーズ第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** がtfstateの観測範囲を扱ったのに対し、第4部では、稼働し続けるインフラに対して、環境ごとに最後に適用したコミットを軸に、検知と収束、緊急対応の手動変更との両立、検知できない範囲を狭める設計までを、GitOpsのパイプラインの中で扱います。ドリフトシリーズとAnsible×Terraformシリーズを読まれた方には答え合わせとして、初めて読まれる方には入り口として、読み進めていただける構成にしています。

正確に言うと、**ドリフトは、パイプラインの外から加えられた変更だけで起きるのではありません。見えないのは記述・記録されていないものであり、このルールは、Ansible、Terraform、GitOpsのどこでも同じ形で働いています**。この回で扱う問いは、「Gitを唯一の真実とする仕組みを積み上げた後に、それでも残るドリフトはどこにあり、何が見えて何が見えないのか」です。

次のセクションでは、**[ドリフトシリーズ](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)** で示したルールが、Ansible、Terraform、GitOpsの3か所で、同じ形で現れることを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 1つのルールが3か所で現れる

**[ドリフトシリーズ](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)** で示した、記述されていない要素は比較の対象にならないというルールが、Ansible、Terraform、GitOpsの3か所で、同じ形で現れることを整理します。

### Ansible：タスクに記述されていない要素

Ansibleの`--check`は、管理対象に接続し、タスクに書かれたあるべき状態と、実際の状態を比べます。**[ドリフトシリーズ第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** では、`--check`で検知できるのは、Ansibleが管理している範囲に限られることを確かめました。**[ドリフトシリーズ第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-03/)** では、タスクに一切登場しないファイルは、cronジョブで書き換えられても検出されないことを確かめています。

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション6でも、Playbookのどのタスクにも書かれていない`/etc/gitops-unmanaged.conf`を作ったところ、`--check`は3台とも`changed=0`でした。Ansibleにとって、タスクに記述されていない要素は、比べる対象に入っていません。

### Terraform：tfstateに記録されていない要素

Terraformの`plan`は、HCLの定義、tfstate、プロバイダーのAPIから取得した現在の属性を比べて、差分を計算します。**[Ansible×Terraformシリーズ第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** では、tfstateに記録されているのは、イメージ、ポート、ネットワークといったリソースの属性で、コンテナの中のファイルやパッケージを示す項目はないことを確かめました。同じ回では、コンテナの中にファイルを作っても`plan`は「No changes」になり、`restart`のような属性の変更は差分として検出されることも確かめています。

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション6でも、Playbookが管理するファイルを手で書き換えたとき、`plan`は「No changes」でした。Terraformにとって、tfstateに記録されていない要素は、比べる対象に入っていません。

### GitOps：記録されていない適用の状態

3つ目は、この回で新しく扱うものです。

Gitのコミットの履歴が記録しているのは、あるべき状態と、その変更です。mainのどのコミットが、どの環境に、いつ適用されたかは、コミットの履歴には含まれません。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション2で整理したとおり、mainの1本と環境ごとのディレクトリで環境を分ける構成では、mainの先頭は「これから適用するコード」を表すだけで、それぞれの環境に今どのコミットが適用されているかは、mainを見ても分かりません。mainにマージしたコミットが、devには適用済みで、prodにはまだ届いていない、という状態は、`git log`には現れません。

そこで、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション5では、環境ごとの「最後に適用したコミット」を、別に記録する仕組みを作りました。記録は、tfstateと同じPostgreSQLの表（`gitops.applied`）に、「GitOps Apply」の適用が成功するたびに1行を足していく形です。Gitのタグで記録する方法もありますが、「GitOps Apply」にリポジトリへの書き込みの権限を与えずに済むよう、Gitの外の表を選んでいます。パイプラインは、この記録を基準に動いています。

* mainへのマージで動く`changes`ジョブは、3つの環境の最後に適用したコミットを読み、そのそれぞれからの差分で、変更されたパスを判定している（プルリクエストでは、プルリクエストの基準のコミットとの差分を見る）
* 「GitOps Apply」の入口の確認は、前の環境に最後に適用したコミットが、今のmainのコミットと同じかを確かめ、昇格の順序を守らせている
* 同じ入口の確認は、その環境に最後に適用したコミットから今のmainまでのマージが、すべてプルリクエストを通っているかを確かめている

この記録がなければ、パイプラインは、mainと、環境に入っている状態とを比べる基準を持てません。GitOpsのパイプラインにとって、記録されていない適用の状態は、比べる対象に入りません。

### 3か所に共通する形

3か所を並べると、次のとおりです。

|比べる場所|比べる基準|比べる相手|比べる対象にならないもの|
|---|---|---|---|
|Ansibleの`--check`|タスクに書かれたあるべき状態|管理対象の実際の状態|タスクに記述されていない要素|
|Terraformの`plan`|HCLの定義とtfstate|プロバイダーのAPIから取得した属性|tfstateに記録されていない要素（OSの中など）|
|GitOpsのパイプライン|Gitのmain|環境ごとに最後に適用したコミットの記録|記録されていない適用の状態|

どれも、比べる側が持っている記述や記録の範囲でしか、比べることができません。記述・記録の外にあるものは、ずれていても差分として現れず、「差分なし」と区別がつきません。

Ansible・Terraformの2つは、ドリフトシリーズとAnsible×Terraformシリーズで確かめてきた形です。3つ目のGitOpsは、少し性質が違います。AnsibleとTerraformの記述・記録は、Gitの中のコードと、Terraformが書くtfstateにあり、ツールがふだんの動きの中で持っているものです。一方、適用の状態は、Gitのコミットの履歴にも、tfstateにも含まれず、パイプラインの側で意図して記録しない限り、どこにも残りません。「Gitが唯一の真実」という考え方をとっても、どの環境がどのコミットまで進んでいるかは、Gitとは別に記録する必要があります。

この3つ目の記録が、この回の後半で、未適用の差分とドリフトを分ける軸になります。

次のセクションでは、本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** で示した3つの経路が、第2部・第3部の仕組みを入れた後に、どうなったかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 3. 3つの経路は塞がったか

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** で示した、「Gitが唯一の真実」が崩れる3つの経路が、第2部・第3部の仕組みを入れた後に、どうなったかを整理します。

### 第2部・第3部で塞いだのは、パイプラインの中の経路

第2部と第3部では、変更がインフラに届く経路を、パイプラインの中で絞ってきました。

* mainへの変更は、プルリクエストで確認し、マージの後に承認ゲートを通して適用する（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）
* 承認ゲートの入口で、ガードレールの結果とplanの判定を確かめる（**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**）
* 適用は、dev、stg、prodの順にしか進まず、適用したコミットが記録に残る（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**）
* 機密情報の入れ替えも、同じプルリクエストと承認ゲートを通す（**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** では、mainへの直接プッシュを止められないため、強制する場所を「mainに入る前」から「インフラに適用する前」に移す方針を示しました。直接プッシュしたコミットは、mainには入りますが、承認ゲートの入口で、プルリクエストを通っていないことが確かめられ、インフラには届きません。

これらの仕組みが制御しているのは、どれも、パイプラインを通って届く変更です。3つの経路に当てはめると、次のとおりです。

|経路|第2部・第3部の仕組みが効くか|今の状態|
|---|---|---|
|① Gitを経由しない手動変更|効かない|パイプラインの外から加えた変更は、パイプラインからは止められない|
|② tfstateの観測範囲外で起きる変化|効かない|Terraformが記録する範囲は、リソースの属性のまま変わっていない|
|③ 収束処理が走らない期間の放置|効かない|パイプラインは、プルリクエスト、マージ、手動の起動のときにしか動かない|

### ① 手動変更は、パイプラインの外にある

パイプラインの外から、操作対象を変える方法は、今の構成にも残っています。

1つ目は、操作対象に直接入る操作です。`docker exec`やSSHで入って設定ファイルを書き換えれば、その変更は、プルリクエストにも承認ゲートにも現れません。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション4で確かめたとおり、この検証環境では、操作する人の鍵が、dev、stg、prodの5台すべての`authorized_keys`に入っていて、1つの鍵でどの環境にも入れます。本シリーズの中でも、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** では、接続用の鍵を入れ替える移行の間をしのぐため、今のコンテナに新しい公開鍵を手で書き足しています。

2つ目は、パイプラインの外で実行するAnsibleやTerraformです。手元から`ansible-playbook`や`terraform apply`を実行すれば、承認ゲートも、昇格の順序の確認も通りません。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** でも、パイプラインが環境を扱えるようになる前の準備として、dev・stgを手元から適用しました。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** で整理したとおり、Terraformにはstateのロックがありますが、Ansibleにはロックがありません。手元のAnsibleの実行は、パイプラインの実行と重なっても止まりません。

パイプラインの外で実行した適用には、もう1つの問題があります。`gitops.applied`の記録は、「GitOps Apply」の適用が成功したときにだけ1行が足されます。手元から適用すれば、環境の中身は変わっても、記録は前のコミットのままです。**[セクション2](#2-1つのルールが3か所で現れる)** で整理した3つ目の記録が、実際の環境とずれることになります。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション5では、承認待ちと`gitops.applied`に直接書き込める人は、順序の確認を迂回できることも整理しています。

**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション7で整理したとおり、①は第2部で減らせても、なくすことはできませんでした。パイプラインが強制できるのは、パイプラインを通る変更だけです。

### ② tfstateの観測範囲は、変わっていない

第2部・第3部で、tfstateの置き場所はpgバックエンドに移り、環境ごとのスキーマに分かれ、機密情報も入らない形になりました。しかし、tfstateに何が記録されるかは、変わっていません。記録されるのは、リソースの属性だけで、コンテナの中のファイルやパッケージは、今も記録の外にあります。Terraformの`plan`は、②の変化を、これからも検出しません。

### ③ パイプラインは、変更のときにしか動かない

今のパイプラインが動くのは、プルリクエストを出したとき、mainにマージしたとき、「GitOps Apply」を手動で起動したときだけです。変更がなければ、どのジョブも動かず、実際の環境を誰も観測していない期間が続きます。

既存の「Drift Check」は、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション3で確かめたとおり、ホステッドランナーの中で一から環境を作り、改ざんを注入して検知するワークフローです。self-hostedランナーの操作対象には触れません。動き続けているdev・stg・prodのずれを見つけるものではなく、③には効いていません。

### 塞いだ経路と、新しく生まれた経路

第2部・第3部の仕組みは、変更をパイプラインに通す経路を整えました。その結果、パイプラインを通る変更については、誰が、いつ、どの環境に、どのコミットを届けたかが分かるようになりました。一方で、3つの経路は、どれもパイプラインの外にあり、そのまま残っています。

さらに、パイプラインの仕組みそのものも、新しい食い違いを生んでいます。次のセクションでは、承認、昇格、revertという、第2部で入れた仕組みが生む乖離を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 4. GitOps自身が生む乖離

第2部で入れた承認、昇格、revertの扱いが、それぞれどのような食い違いを生むのかを整理します。

**[セクション3](#3-3つの経路は塞がったか)** で整理した3つの経路は、パイプラインの外から生まれる食い違いでした。ここで扱うのは、パイプラインの仕組みそのものが生む食い違いです。

### 承認ゲートは、「マージ済みで未適用」の状態を生む

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、マージで作ったplanを承認待ちとして保存し、「GitOps Apply」の手動の起動を承認とする承認ゲートを作りました。プッシュのたびにインフラが変わる状態を避けるための仕組みです。

その代わりに、mainにマージした変更は、承認されるまでインフラに届きません。マージから承認までの間、mainと実際の環境は、設計として食い違っています。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション5では、承認待ちを破棄した変更が、mainにはあるが適用されていない差分として残ることも確かめています。承認されなかった変更は、次に誰かが適用するまで、mainにだけある状態が続きます。

### 昇格の順序は、「環境ごとに違うコミット」の状態を生む

**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** では、1回のマージで、dev、stg、prodの3つの承認待ちを作り、前の環境に同じコミットを適用し終えるまで、次の環境に適用できない形にしました。

この形では、devには適用済みで、stgとprodにはまだ届いていない、という状態が、昇格の途中に必ず生まれます。3つの環境は、同じmainから作られていても、それぞれ違うコミットの状態にあります。同じ回のセクション5では、昇格の途中で新しいマージがあると、承認待ちが新しいコミットで上書きされ、stgとprodには前のコミットを適用できなくなり、devからやり直すことになると整理しました（コードから読み取れる動きとして整理したもので、実際には確かめていません）。マージの頻度が高い運用では、prodが前のコミットのまま留まる期間が長くなります。

### revertは、記述されていない残骸を生む

**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** では、`git revert`で戻るのは、revertの後のコードに元の状態が書かれているものだけであることを確かめました。タスクで足したものは、そのタスクをrevertで消しても、操作対象に残ります。足したものを取り消すときは、revertではなく、「消す」と書いた変更を前に進める必要があります。同じ回では、複数の環境があると、消す変更が一部の環境で飛ばされることも確かめています。

revertで残ったものは、もうどのタスクにも書かれていません。**[セクション2](#2-1つのルールが3か所で現れる)** のルールでは、タスクに記述されていない要素は、`--check`の比較の対象になりません。revertの残骸は、手動変更のように外から持ち込まれたものではなく、パイプラインを通した変更が、記述されていない要素を自分で作り出したものです。しかも、revertのコミットは承認ゲートを通って適用され、`gitops.applied`には「適用済み」として記録されます。記録の上では、その環境は最新のコミットの状態にあり、残骸の存在は、記録からも見えません。

### 3つの食い違いは、性質が違う

3つを並べると、次のとおりです。

|仕組み|生む状態|設計どおりか|記録と比べて分かるか|
|---|---|---|---|
|承認ゲート（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）|mainにマージ済みで、まだ適用していない|設計どおり|分かる（mainと、最後に適用したコミットが違う）|
|昇格の順序（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**）|環境ごとに、適用したコミットが違う|設計どおり|分かる（環境ごとに、最後に適用したコミットが違う）|
|revert（**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**）|どのタスクにも書かれていない設定が残る|設計の外|分からない（記録は適用済みを示す）|

承認ゲートと昇格の順序が生む食い違いは、変更を人が確かめてから、順に届けるために、意図して作ったものです。どちらも、mainと、環境ごとに最後に適用したコミットを比べれば、どこまで届いていて、どこから届いていないかが分かります。

revertの残骸は、性質が違います。最後に適用したコミットは記録どおりなのに、実際の環境には、そのコミットのどこにも書かれていないものが残っています。記録と比べても分からず、`--check`でも`plan`でも見えません。

ガードレールや承認を入れて、変更を慎重に届ける仕組みを作ったこと自体が、食い違いを生んでいます。ただし、その中には、記録で説明できる食い違いと、記録でも説明できない食い違いが混ざっています。この2つを分けずに扱うと、設計どおりの未適用の状態をドリフトとして戻そうとしたり、逆に、本当のドリフトを未適用の状態と見過ごしたりすることになります。

次のセクションでは、「main」「最後に適用したコミット」「実環境」の3つの状態を区別し、この2つを分けます。

---

[↑ 目次に戻る](#-目次)

---

## 5. 3つの状態で乖離を分ける

「main」「最後に適用したコミット」「実環境」の3つの状態を区別し、マージ済みで未適用の状態を実機で作って、未適用の差分とドリフトを、記録で分けられることを確かめます。

### 3つの状態と、2つの差

**[セクション4](#4-gitops自身が生む乖離)** で整理した食い違いを、次の3つの状態の間の差として捉え直します。

```plaintext
main（Gitの定義。これから適用するもの）
　│
　│　未適用の差分：承認や昇格を待っている変更
　↓
最後に適用したコミット（環境ごとの記録。gitops.applied）
　│
　│　ドリフト：適用した後に、実環境が記録から離れた分
　↓
実環境（実際のコンテナやサーバーの状態）
```

* **未適用の差分**：mainと、最後に適用したコミットの差。承認ゲートと昇格の順序が、設計として生むもので、承認と昇格で解消する
* **ドリフト**：最後に適用したコミットと、実環境の差。設計の外で生まれるもので、検知と収束の対象になる

この2つを分けるには、環境ごとに最後に適用したコミットが記録されている必要があります。**[セクション2](#2-1つのルールが3か所で現れる)** で整理した、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** の`gitops.applied`が、その記録です。

### ■ 検証内容：マージ済みで未適用の状態を作る

今の3つの環境は、どれもmainの`00cc80b`を適用済みで、未適用の差分はありません。ここに、Ansibleのロールの変更を1つマージし、承認待ちのまま、どの環境にも適用しない状態を作ります。

変更は、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション5で昇格の確認に使ったのと同じ、環境の名前を書いたファイル（`/etc/gitops-env.conf`）に1行を足すものです。5台すべてに差分を生み、Terraformには関係しません。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops17-pending-check
sed -i 's/promotion=dev-stg-prod\\n"/promotion=dev-stg-prod\\ngitops17=pending-check\\n"/' ansible/roles/common_setup/tasks/environment.yml
git --no-pager diff
git add ansible/roles/common_setup/tasks/environment.yml
git commit -m "GitOps第17回: 未適用の差分を確かめるため、環境ファイルへ1行足す"
git push -u origin gitops17-pending-check
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops17-pending-check'
diff --git a/ansible/roles/common_setup/tasks/environment.yml b/ansible/roles/common_setup/tasks/environment.yml
index 43fcfe2..019e4e2 100644
--- a/ansible/roles/common_setup/tasks/environment.yml
+++ b/ansible/roles/common_setup/tasks/environment.yml
@@ -3,5 +3,5 @@
   become: true
   ansible.builtin.copy:
     dest: /etc/gitops-env.conf
-    content: "env={{ common_setup_env }}\npromotion=dev-stg-prod\n"
+    content: "env={{ common_setup_env }}\npromotion=dev-stg-prod\ngitops17=pending-check\n"
     mode: "0644"
[gitops17-pending-check 94d514a] GitOps第17回: 未適用の差分を確かめるため、環境ファイルへ1行足す
 1 file changed, 1 insertion(+), 1 deletion(-)
（以降省略）
```

このブランチから、プルリクエスト（PR#84）を作りました。確認の実行（「GitOps Pipeline」の実行#152）では、`changes`、`ansible-lint`、`molecule`、`ansible-check`が成功し、Terraformの2つのジョブと`record-pending`はスキップされました。PR#84をマージしました（マージコミット`0ce29b9`、「GitOps Pipeline」の実行#153）。

**▼ 実行結果**（「GitOps Pipeline」の実行#153、`changes`ジョブから抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  EVENT_NAME: push
  BASE_SHA: 00cc80b198e0c51b3a10a387b3f9ac0d3a9b0644
  HEAD_SHA: 0ce29b97e0a804f07ae48651294063fb8d71e37e
（途中省略）
last applied (dev): 00cc80b198e0c51b3a10a387b3f9ac0d3a9b0644
last applied (stg): 00cc80b198e0c51b3a10a387b3f9ac0d3a9b0644
last applied (prod): 00cc80b198e0c51b3a10a387b3f9ac0d3a9b0644
ansible/roles/common_setup/tasks/environment.yml
terraform=false
ansible=true
```

**▼ 実行結果**（「GitOps Pipeline」の実行#153、`record-pending`ジョブから抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
== dev
（途中省略：ファイルの一覧）
commit=0ce29b97e0a804f07ae48651294063fb8d71e37e
terraform=false
ansible=true
== stg
（途中省略：devと同じ内容）
== prod
（途中省略：devと同じ内容）
```

3つの環境の最後に適用したコミット（`00cc80b`）を基準に、変更が判定され、3環境の承認待ちが、マージコミット`0ce29b9`で作られました。この承認待ちは、適用せずに残します。

### ■ 検証内容：確認モードは、未適用の差分をどう表示するか

同じ実行#153の`ansible-check`ジョブは、mainのコード（`0ce29b9`）で、3つの環境に確認モードを実行しています。その結果です。

**▼ 実行結果**（「GitOps Pipeline」の実行#153、`ansible-check`ジョブから抜粋）

```plaintext
== dev
（途中省略：PLAYとTASKの表示、Pythonのインタープリターに関する警告）
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before: /etc/gitops-env.conf
+++ after: /etc/gitops-env.conf
@@ -1,2 +1,3 @@
 env=dev
 promotion=dev-stg-prod
+gitops17=pending-check

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
== stg
（途中省略：devと同じ形の表示。差分はenv=stgの後に+gitops17=pending-check）
stg-node1                  : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
== prod
（途中省略：devと同じ形の表示。差分は3台ともenv=prodの後に+gitops17=pending-check）
target-node1               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

5台すべてで、`/etc/gitops-env.conf`の差分が予測されました（`changed=1`）。この表示だけを見ると、**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション6で、ファイルを手で書き換えたときの`--check`の表示と、区別がつきません。確認モードが比べているのは、実行したコードと実環境であり、その差が、まだ適用していない変更によるものか、適用した後に実環境が変わったものかは、表示に現れないためです。

### ■ 検証内容：記録と照らし合わせる

手元で、環境ごとに最後に適用したコミットを読み、そこからmainまでのコミットと、変わったファイルを並べます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for e in dev stg prod; do a=$(.github/scripts/applied.sh last $e); echo "== $e last applied: $a"; git log --oneline "$a..main"; git --no-pager diff --stat "$a" main; done
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えと、mainの更新の表示）
== dev last applied: 00cc80b198e0c51b3a10a387b3f9ac0d3a9b0644
0ce29b9 (HEAD -> main, origin/main) Merge pull request #84 from juehara-crypto/gitops17-pending-check
94d514a GitOps第17回: 未適用の差分を確かめるため、環境ファイルへ1行足す
 ansible/roles/common_setup/tasks/environment.yml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
== stg last applied: 00cc80b198e0c51b3a10a387b3f9ac0d3a9b0644
（途中省略：devと同じ表示）
== prod last applied: 00cc80b198e0c51b3a10a387b3f9ac0d3a9b0644
（途中省略：devと同じ表示）
```

続けて、最後に適用したコミット（`00cc80b`）とmainのコードで、ファイルの中身を決める行を並べ、5台の実際のファイルと比べます。

**実行コマンド**

```plaintext
echo "== 00cc80b"; git show 00cc80b:ansible/roles/common_setup/tasks/environment.yml | grep 'content:'
echo "== main"; git show main:ansible/roles/common_setup/tasks/environment.yml | grep 'content:'
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n cat /etc/gitops-env.conf; done
```

**▼ 実行結果**

```plaintext
== 00cc80b
    content: "env={{ common_setup_env }}\npromotion=dev-stg-prod\n"
== main
    content: "env={{ common_setup_env }}\npromotion=dev-stg-prod\ngitops17=pending-check\n"
== dev-node1
env=dev
promotion=dev-stg-prod
== stg-node1
env=stg
promotion=dev-stg-prod
== target-node1
env=prod
promotion=dev-stg-prod
（途中省略：target-node2、target-node3もtarget-node1と同じ）
```

### ■ 結果

3つの状態を並べると、次のとおりです。

|状態|中身|
|---|---|
|main|`0ce29b9`。`gitops17=pending-check`の行を足すコード|
|最後に適用したコミット|3環境とも`00cc80b`。足す前のコード|
|実環境|5台とも、`00cc80b`のコードどおりの2行|

確認モードが5台に出した`changed=1`は、mainと実環境の差でした。記録と照らし合わせると、その差は、すべてmainと最後に適用したコミットの間（PR#84の1つのマージ）にあり、実環境は最後に適用したコミットの状態と一致しています。この`changed=1`は、ドリフトではなく、未適用の差分です。

### 未適用の差分は、承認と昇格で解消する

未適用の差分は、設計どおりの状態なので、検知して戻すのではなく、承認と昇格で解消します。「GitOps Apply」で、dev（実行#90）、stg（実行#91）、prod（実行#92）の順に適用しました。どの実行も、昇格の順序の確認を通り、`ansible-apply`で`+gitops17=pending-check`を書き込んで、`record-applied`で最後に適用したコミットを`0ce29b9`に更新しています。

**実行コマンド**

```plaintext
ls -la ~/gitops-pending
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
for e in dev stg prod; do a=$(.github/scripts/applied.sh last $e); echo "== $e last applied: $a"; git log --oneline "$a..main"; done
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct 22 05:46 .
drwxr-x--- 14 control control 4096 Oct 22 05:39 ..
 id | env  |                commit_sha
----+------+------------------------------------------
 58 | prod | 0ce29b97e0a804f07ae48651294063fb8d71e37e
 57 | stg  | 0ce29b97e0a804f07ae48651294063fb8d71e37e
 56 | dev  | 0ce29b97e0a804f07ae48651294063fb8d71e37e
(3 rows)

== dev last applied: 0ce29b97e0a804f07ae48651294063fb8d71e37e
== stg last applied: 0ce29b97e0a804f07ae48651294063fb8d71e37e
== prod last applied: 0ce29b97e0a804f07ae48651294063fb8d71e37e
```

承認待ちは空になり、3つの環境とも、最後に適用したコミットがmainと同じになりました。未適用のコミットは、もうありません。

### 記録がなければ、2つの差は混ざる

ここまでの結果を、2つの差として並べます。

|差|比べるもの|設計どおりか|解消する手段|扱う回|
|---|---|---|---|---|
|未適用の差分|mainと、最後に適用したコミット|設計どおり|承認と昇格|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|
|ドリフト|最後に適用したコミットと、実環境|設計の外|検知と収束|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**|

確認モードも`terraform plan`も、比べているのは、実行したコードと実環境です。mainのコードで実行すれば、結果には、未適用の差分とドリフトが混ざって現れます。この検証では、ドリフトがなかったため、`changed=1`はすべて未適用の差分でしたが、両方があれば、表示からは分けられません。

2つを分けられたのは、環境ごとに最後に適用したコミットが記録されていたからです。記録があれば、mainと記録の差は未適用の差分として説明でき、それ以外の差は、記録と実環境の差、つまりドリフトとして扱えます。逆に言えば、ドリフトだけを見たいときは、mainではなく、最後に適用したコミットのコードで、実環境と比べる必要があります。何と何を比べるかは、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** で定期的な検知を作るときの前提になります。

次のセクションでは、未適用の差分がない状態で、Terraformが管理するリソースの属性を手で変え、記録と照らし合わせて、それがドリフトだと判断できることを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 6. ドリフトを記録で見分ける

未適用の差分がない状態で、Terraformが管理するコンテナの属性を手で変え、最後に適用したコミットの記録と照らし合わせて、それがドリフトだと判断できることを確かめます。

### ■ 検証内容：記録とmainの一致を確かめ、属性を手で変える

**[セクション5](#5-3つの状態で乖離を分ける)** の最後で、3つの環境とも、最後に適用したコミットがmainと同じになりました。ここでは、devだけを使います。まず、devの記録とmainが一致していることを確かめ、そのうえで、dev-node1のCPUの割り当て（`cpu_shares`）を、`docker update`で直接512に変えます。

`docker update`で変えられる属性のうち、`restart`は、**[Ansible×Terraformシリーズ第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** で確かめているため、ここでは`cpu_shares`を使います。変える前の値は、Dockerの実際の値も、tfstateの記録も、`0`でした。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
git log --oneline -1
echo "dev last applied: $(.github/scripts/applied.sh last dev)"
git log --oneline "$(.github/scripts/applied.sh last dev)..main"; echo "unapplied_commits_exit_code=$?"
docker update --cpu-shares 512 dev-node1
docker inspect -f 'restart={{.HostConfig.RestartPolicy.Name}} memory={{.HostConfig.Memory}} cpu_shares={{.HostConfig.CpuShares}}' dev-node1
```

**▼ 実行結果**

```plaintext
0ce29b9 (HEAD -> main, origin/main) Merge pull request #84 from juehara-crypto/gitops17-pending-check
dev last applied: 0ce29b97e0a804f07ae48651294063fb8d71e37e
unapplied_commits_exit_code=0
dev-node1
restart=no memory=0 cpu_shares=512
```

devの最後に適用したコミットは、mainと同じ`0ce29b9`で、未適用のコミットはありません。その状態で、dev-node1の`cpu_shares`だけが512になりました。

続けて、Git、Terraform、Ansibleのそれぞれで、この変更が見えるかを確かめます。

**実行コマンド**

```plaintext
git status --short; echo "git_status_exit_code=$?"
terraform -chdir=terraform/envs/dev plan -input=false -no-color -detailed-exitcode > /tmp/gitops17-plan-dev.log 2>&1; echo "plan_exit_code=$?"
grep -E '^  # |cpu_shares|forces replacement|^Plan:|No changes' /tmp/gitops17-plan-dev.log
rm /tmp/gitops17-plan-dev.log
cd ansible
ansible-playbook -i inventories/dev site.yml --check --vault-id gitops16@$HOME/.config/ansible-vault/gitops16-vault-pass 2>/dev/null | grep -E ': ok='
cd ..
```

**▼ 実行結果**

```plaintext
git_status_exit_code=0
plan_exit_code=2
  # module.lab_env.docker_container.targets["dev-node1"] will be updated in-place
      - cpu_shares                                  = 512 -> null
Plan: 0 to add, 1 to change, 0 to destroy.
dev-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

|確かめた場所|結果|理由|
|---|---|---|
|Git|検出しない（`git_status_exit_code=0`）|リポジトリの中のファイルは、何も変わっていない|
|Terraformの`plan`|検出する（`512 -> null`、その場の更新）|`cpu_shares`は、tfstateに記録されたリソースの属性|
|Ansibleの`--check`|検出しない（`changed=0`）|`cpu_shares`は、どのタスクにも書かれていない|

**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション6では、Playbookが管理するファイルの手動変更を、Ansibleだけが検出し、Terraformは検出しませんでした。今回は逆で、Terraformだけが検出し、Ansibleは検出しませんでした。**[セクション2](#2-1つのルールが3か所で現れる)** で整理したとおり、どちらのツールも、自分が持っている記述・記録の範囲でしか比べていません。

`plan`の差分は、`512 -> null`でした。コードには`cpu_shares`を書いていないため、Terraformは、手で変えた値を「指定なし」に戻す計画を立てています。tfstateには、コードに書いていない属性も、作ったときの値（`0`）として記録されていて、その記録と実際の値が比べられています。

この`plan`の差分は、**[セクション5](#5-3つの状態で乖離を分ける)** の確認モードの`changed=1`と同じく、実行したコードと実環境の差です。違うのは、記録です。devの最後に適用したコミットはmainと同じで、未適用の差分はありません。そのため、この差分は、最後に適用したコミットと実環境の差、つまりドリフトだと判断できます。

### ■ 検証内容：手で元に戻す

手で変えた値を、同じ`docker update`で0に戻します。

**実行コマンド**

```plaintext
docker update --cpu-shares 0 dev-node1
docker inspect -f 'restart={{.HostConfig.RestartPolicy.Name}} memory={{.HostConfig.Memory}} cpu_shares={{.HostConfig.CpuShares}}' dev-node1
terraform -chdir=terraform/envs/dev plan -input=false -no-color -detailed-exitcode > /tmp/gitops17-plan-dev.log 2>&1; echo "plan_exit_code=$?"
grep -E '^  # |cpu_shares|^Plan:|No changes' /tmp/gitops17-plan-dev.log
rm /tmp/gitops17-plan-dev.log
```

**▼ 実行結果**

```plaintext
dev-node1
restart=no memory=0 cpu_shares=512
plan_exit_code=2
  # module.lab_env.docker_container.targets["dev-node1"] will be updated in-place
      - cpu_shares                                  = 512 -> null
Plan: 0 to add, 1 to change, 0 to destroy.
```

### ■ 結果

`docker update --cpu-shares 0`は、エラーにならずに終わりましたが、値は512のままでした。`plan`の差分も、そのまま残っています。

手で加えた変更を、同じ手段では元に戻せませんでした。元の値の0は、コードにも書いておらず、コンテナを作ったときに決まった値です。このように、コードに書いていない属性を手で変えると、手作業で元の状態に戻せるとは限りません。

### ■ 検証内容：作り直して戻す

元の状態に戻すには、dev-node1を作り直します。パイプラインの承認待ちは、マージのときにしか作られないため、ここでは手元から、devだけで作り直しました。**[セクション3](#3-3つの経路は塞がったか)** で整理した、パイプラインの外での適用に当たります。ただし、適用するコードは、devに最後に適用したコミット（`0ce29b9`）と同じです。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform/envs/dev
set -a; . ~/.config/tfstate-backend/backend.env; set +a
mkdir -p -m 700 ~/gitops17-plans
(umask 077; terraform plan -input=false -no-color -replace='module.lab_env.docker_container.targets["dev-node1"]' -out="$HOME/gitops17-plans/tfplan-dev" > /dev/null); echo "plan_exit_code=$?"
terraform show -no-color "$HOME/gitops17-plans/tfplan-dev" | grep -E '^  # |cpu_shares|^Plan:'
terraform apply -input=false "$HOME/gitops17-plans/tfplan-dev" 2>&1 | grep -E 'Destroying|Destruction complete|Creation complete|Apply complete'
rm -rf ~/gitops17-plans
docker inspect -f '{{.Name}} id={{printf "%.12s" .Id}} cpu_shares={{.HostConfig.CpuShares}} {{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}}{{end}}' dev-node1
terraform plan -input=false -detailed-exitcode > /dev/null 2>&1; echo "plan_after_exit_code=$?"
cd ~/iac/docker-lab-ci
```

**▼ 実行結果**

```plaintext
plan_exit_code=0
  # module.lab_env.docker_container.targets["dev-node1"] will be replaced, as requested
      - cpu_shares                                  = 512 -> null
Plan: 1 to add, 0 to change, 1 to destroy.
module.lab_env.docker_container.targets["dev-node1"]: Destroying... [id=f4104de77bf8f84b3ce53a76a1cf2581c5fdae52ce16287d51119cf6255d260c]
module.lab_env.docker_container.targets["dev-node1"]: Destruction complete after 1s
module.lab_env.docker_container.targets["dev-node1"]: Creation complete after 2s [id=5fc109d36684133ed6af332be38410d97d001699700e35d2d323dd25a7b459e0]
Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
/dev-node1 id=5fc109d36684 cpu_shares=0 ansible-dev-net=172.20.0.2
plan_after_exit_code=0
```

作り直したdev-node1には、Ansibleの設定が入っていません。同じコードで、devに`ansible-playbook`を実行し、設定を入れ直しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
ansible-playbook -i inventories/dev site.yml --vault-id gitops16@$HOME/.config/ansible-vault/gitops16-vault-pass 2>/dev/null | grep -E 'changed:|: ok='
ansible-playbook -i inventories/dev site.yml --check --vault-id gitops16@$HOME/.config/ansible-vault/gitops16-vault-pass 2>/dev/null | grep -E ': ok='
docker exec dev-node1 cat /etc/gitops-env.conf /etc/drift-check-target.conf
cd ~/iac/docker-lab-ci
echo "dev last applied: $(.github/scripts/applied.sh last dev)"
```

**▼ 実行結果**

```plaintext
changed: [dev-node1]
changed: [dev-node1]
changed: [dev-node1]
dev-node1                  : ok=6    changed=3    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
dev-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
env=dev
promotion=dev-stg-prod
gitops17=pending-check
monitored_by=ansible-drift-check
dev last applied: 0ce29b97e0a804f07ae48651294063fb8d71e37e
```

### ■ 結果

作り直したdev-node1は、`cpu_shares=0`に戻り、`plan`は差分なし（`plan_after_exit_code=0`）になりました。Ansibleで、ファイル2つとパスワードを入れ直し（`changed=3`）、確認モードは`changed=0`です。devの最後に適用したコミットは`0ce29b9`のままで、実環境は、再び記録と一致しています。

ただし、戻すための作業は、パイプラインの外で行うことになりました。作り直しによって、コンテナのIDも変わっています（`f4104de77bf8`から`5fc109d36684`）。ドリフトを見つけた後に、どう戻すかを、パイプラインの中で扱う仕組みは、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** で作ります。

### 同じ表示を、記録が分ける

**[セクション5](#5-3つの状態で乖離を分ける)** とこのセクションの結果を並べます。

|項目|セクション5|このセクション|
|---|---|---|
|検出したもの|Ansibleの`--check`（5台で`changed=1`）|Terraformの`plan`（dev-node1の`cpu_shares`）|
|mainと、最後に適用したコミット|違う（`0ce29b9`と`00cc80b`）|同じ（どちらも`0ce29b9`）|
|実環境と、最後に適用したコミット|一致している|違う（`cpu_shares`が512）|
|判断|未適用の差分|ドリフト|
|解消する手段|承認と昇格（dev→stg→prodの順に適用）|元に戻す（今回は作り直し）|

どちらも、ツールの表示は「差分あり」でした。表示だけでは、承認を待っている変更なのか、誰かが手で変えたものなのかは分かりません。分けたのは、環境ごとに最後に適用したコミットの記録です。記録とmainが違えば、その差は未適用の差分として説明でき、記録とmainが同じなのに差分が出れば、それは記録の後に実環境が変わったもの、つまりドリフトです。

次のセクションでは、Terraformの`plan`とAnsibleの`--check`で検出できる範囲と、どちらでも検出できない範囲を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. 検出できるドリフトと検出できないドリフト

Terraformの`plan`とAnsibleの`--check`で検出できるドリフトと、どちらでも検出できないドリフトを整理し、第4部の後の回が、それぞれをどこで扱うかを示します。

### 3つの検出範囲

**[セクション5](#5-3つの状態で乖離を分ける)** と **[セクション6](#6-ドリフトを記録で見分ける)** で、未適用の差分とドリフトを、記録で分けられることを確かめました。ただし、記録で分けられるのは、ツールが差分として表示したものだけです。ツールが表示しないものは、記録と照らし合わせる対象にもなりません。

ドリフトを、検出できるツールで分けると、次の3つになります。

|検出範囲|比べているもの|この回と、これまでの例|
|---|---|---|
|Terraformの`plan`で検出できる|tfstateに記録されたリソースの属性と、実際の属性|`cpu_shares`の手動変更（**[セクション6](#6-ドリフトを記録で見分ける)**）、`restart`の変更（**[Ansible×Terraformシリーズ第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)**）|
|Ansibleの`--check`で検出できる|タスクに書かれたあるべき状態と、実際の状態|Playbookが管理するファイルの手動変更（本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション6）|
|どちらでも検出できない|（比べる対象がない）|記述・記録されていない要素、revertの残骸、`ignore_changes`で意図して外した属性|

`--check`で検出できる範囲の詳しい整理は、**[ドリフトシリーズ第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** で扱っています。タスクに記述されていない変化の具体例（cronや自動更新による書き換え）は、**[ドリフトシリーズ第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-03/)** で扱っています。

### どちらでも検出できない3つのもの

3つ目の範囲には、性質の違うものが入っています。

**記述・記録されていない要素。** Playbookのどのタスクにも書かれておらず、tfstateにも記録されていないものです。本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション6で作った`/etc/gitops-unmanaged.conf`は、Git、Terraform、Ansibleのいずれも検出しませんでした。**[セクション2](#2-1つのルールが3か所で現れる)** のルールが、そのまま現れる範囲です。

**revertの残骸。** **[セクション4](#4-gitops自身が生む乖離)** で整理したとおり、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** の`git revert`で消えずに残ったものは、もうどのタスクにも書かれていません。性質は1つ目と同じですが、外から持ち込まれたのではなく、パイプラインを通した変更が作り出したものです。

**`ignore_changes`で意図して外した属性。** Terraformの`lifecycle`の`ignore_changes`に書いた属性は、コードとtfstateの差を、計画の判断から外します。本シリーズでは、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション3で、イメージの`build`を`ignore_changes`に入れ、`context`の文字列が変わっただけでイメージとコンテナが作り直されるのを避けました。コンテナの`network_mode`も、同じく外しています。その代わり、`build`の中身を変えても、イメージは作り直されません。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション5では、この形のために、パスワードを変えても古いパスワードがイメージに残り続けることを整理しています。作り直しを避けるために外した属性は、ずれても`plan`に現れません。

3つに共通しているのは、比べる側に、比べるための記述も記録もないことです。記述・記録がないものは、ずれていても「差分なし」と同じ表示になります。

### 検知と収束が扱えるのは、前の2つだけ

第4部の後の回は、この3つの範囲を、次のように扱います。

|検出範囲|扱う回|扱い方|
|---|---|---|
|Terraformの`plan`で検出できる|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**|定期的に検知し、最後に適用したコミットに収束させる|
|Ansibleの`--check`で検出できる|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**|同上|
|どちらでも検出できない|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**|検出できない範囲そのものを狭める|

**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の定期的な検知と、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** の自動収束は、`plan`と`--check`の上に作ります。そのため、対象にできるのは、前の2つの範囲だけです。検知の仕組みをどれだけ整えても、3つ目の範囲は、検知の結果には現れません。

3つ目の範囲に対してできることは、検知ではなく、防ぐことです。**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** では、ドリフトを扱う設計を、防ぐ・検知する・修正するの3つで整理しました。3つ目の範囲は、このうち「防ぐ」でしか扱えません。

* 記述・記録されていない要素は、管理の対象の範囲を広げて、記述・記録されている側に移すか、管理の対象の外にあると決めて記録する
* revertの残骸は、revertで取り消すのではなく、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** で整理したとおり、「消す」と書いた変更を前に進めることで、残骸そのものを作らない
* `ignore_changes`で外した属性は、外した理由と、外したことで見えなくなるものを、コードの側に残しておく

検出できない範囲を、どう洗い出し、どう減らすかは、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)** で扱います。

次のセクションでは、ここまでの整理が、クラウドのプロバイダーでも同じように当てはまることを示します。

---

[↑ 目次に戻る](#-目次)

---

## 8. クラウドでも同じルールが働く

ここまでの整理が、TerraformのプロバイダーをAWSやGCPに切り替えたときに、どこが変わり、どこが変わらないかを整理します。クラウドでの実行は行っていないため、ここでは、この回の結果と、クラウドでの対応を並べて比べます。

### ドリフトの経路が増える

この検証環境で、パイプラインの外から操作対象を変える方法は、`docker exec`や`docker update`、SSHでした。クラウドでは、ここに次のような経路が加わります。

* 管理コンソールやCLIからの変更：インスタンスのタイプ、タグ、セキュリティグループのルールなどを、人が直接書き換える
* 別の自動化ツールやサービスによる変更：オートスケーリングによる台数の増減、別のチームの自動化ツール、クラウドの側で自動的に行われる更新など、Terraformの外で動く仕組みが、同じリソースを書き換える

どちらも、Gitを通らない変更です。**[セクション3](#3-3つの経路は塞がったか)** で整理した「① Gitを経由しない手動変更」の入口が、クラウドではより多くあるということです。パイプラインを整えても、これらの経路はパイプラインの外にあり、塞げない点は変わりません。

### 何が見えるかは、同じルールで決まる

経路が増えても、どの変化がどのツールで見えるかは、**[セクション2](#2-1つのルールが3か所で現れる)** のルールで決まります。

|変化|この検証環境|AWS・GCP|検出できるもの|
|---|---|---|---|
|リソースの属性の変更|`docker update`による`cpu_shares`の変更（**[セクション6](#6-ドリフトを記録で見分ける)**）|コンソールやCLIからの、インスタンスのタイプやタグの変更|Terraformの`plan`|
|OSの中の、タスクに書かれた要素の変更|`docker exec`による設定ファイルの書き換え（本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション6）|SSHなどで入って、設定ファイルを書き換える|Ansibleの`--check`|
|記述・記録されていない要素の変更|タスクにないファイルの追加（本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション6）|タスクにないファイルや、Terraformで管理していないリソースの追加|どちらでも検出できない|
|`ignore_changes`で外した属性の変更|イメージの`build`、コンテナの`network_mode`|ほかの仕組みに任せたタグや台数など|どちらでも検出できない|

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション8で整理したとおり、コンソールからインスタンスの属性を変えた場合は、tfstateの観測範囲の中の変化なので、`plan`で検出されます。インスタンスの中のOSの変化は、Docker、AWS、GCPのどれであっても、tfstateには記録されません。

一方で、クラウドでは、オートスケーリングが台数を変える、別のシステムがタグを付けるといった、Terraformの外の仕組みと同じ属性を共有する場面があります。Terraformがそれを元に戻そうとしないよう、その属性を`ignore_changes`で外すと、**[セクション7](#7-検出できるドリフトと検出できないドリフト)** で整理したとおり、ずれても`plan`に現れなくなります。外す属性が増えれば、その分だけ、検出できない範囲も広がります。

### 記録の要否も、変わらない

**[セクション5](#5-3つの状態で乖離を分ける)** と **[セクション6](#6-ドリフトを記録で見分ける)** で、`plan`や`--check`の「差分あり」が、未適用の差分なのかドリフトなのかを分けたのは、環境ごとに最後に適用したコミットの記録でした。

この記録の要否は、プロバイダーに関係しません。`plan`も`--check`も、比べているのは実行したコードと実環境で、どのコミットを適用したかは、どちらのツールも記録しないためです。クラウドでも、承認ゲートと昇格の順序を持つ構成であれば、mainと実環境の間には、未適用の差分とドリフトが混ざります。記録の置き場所は、この検証環境のようにtfstateと同じデータベースでも、クラウドのストレージやデータベースでも構いません。変わるのは置き場所だけで、記録が要ることは変わりません。

プロバイダーを切り替えて変わるのは、ドリフトが入ってくる経路と、`ignore_changes`で外す属性です。記述・記録されていないものは見えないというルールと、「main」「最後に適用したコミット」「実環境」の3つの状態の区別は、プロバイダーを問わず同じです。

次のセクションでは、この回の内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 9. まとめ

この回で整理した内容を確認します。

* ドリフトシリーズで示した、記述されていない要素は比較の対象にならないというルールは、Ansible、Terraform、GitOpsの3か所で同じ形で現れる。Ansibleの`--check`はタスクに記述された要素だけを、Terraformの`plan`はtfstateに記録されたリソースの属性だけを比べる。GitOpsのパイプラインは、どのコミットをどの環境に適用したかを、Gitのコミットの履歴には持たず、環境ごとの「最後に適用したコミット」の記録がなければ、mainと環境の状態を比べる基準を持てない
* 第2部・第3部で、変更をパイプラインに通す経路は整えたが、本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** で示した3つの経路（Gitを経由しない手動変更、tfstateの観測範囲外で起きる変化、収束処理が走らない期間の放置）は、どれもパイプラインの外にあり、残っている。パイプラインの外での適用は、`gitops.applied`の記録と実環境もずらす
* 承認ゲートは「mainにマージ済みで未適用」の状態を、昇格の順序は「環境ごとに適用したコミットが違う」状態を、設計として生む。revertは、どのタスクにも書かれていない残骸を生み、その環境は記録の上では最新のコミットを適用済みのまま残る
* 「main」「最後に適用したコミット」「実環境」の3つを区別すると、mainと最後に適用したコミットの差である未適用の差分と、最後に適用したコミットと実環境の差であるドリフトを分けられる。Ansibleのロールの変更をマージして適用しない状態を作ると、確認モードは5台すべてで`changed=1`を表示したが、記録と照らし合わせると、その差はすべて未適用の差分で、実環境は最後に適用したコミットの状態と一致していることを実機で確認した。未適用の差分は、dev→stg→prodの順の適用で解消した
* 記録とmainが一致している状態で、コンテナの`cpu_shares`を手で変えると、Terraformの`plan`だけが差分を検出し、GitとAnsibleは検出しないことを実機で確認した。記録とmainが同じなので、この差分はドリフトだと判断できる。手で変えた値は、同じ`docker update`では元に戻せず、コンテナを作り直して戻した
* ドリフトの検出範囲は、Terraformの`plan`で検出できるもの、Ansibleの`--check`で検出できるもの、どちらでも検出できないもの（記述・記録されていない要素、revertの残骸、`ignore_changes`で意図して外した属性）の3つに分かれる。検知と自動収束が対象にできるのは前の2つだけで、3つ目は「防ぐ」設計でしか扱えない
* クラウドでは、管理コンソールや別の自動化ツールによる変更が、ドリフトの経路として加わり、Terraformの外の仕組みと共有する属性を`ignore_changes`で外せば、その分だけ検出できない範囲が広がる。記述・記録されていないものは見えないというルールと、3つの状態の区別は、プロバイダーを問わず同じである

---

[↑ 目次に戻る](#-目次)

---

## 10. 次回予告

本シリーズの **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)** では、置き場所を決めた秘密が漏れたとき、失われたときの対応を扱い、新旧の両方を受け付ける移行期間を作って、Vaultパスワード、`ansible`のパスワード、接続用の鍵の入れ替えをパイプラインに通して、第3部を終えました。第17回となる今回は、第4部の初回として、**[ドリフトシリーズ](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)** で示した、記述されていない要素は比較の対象にならないというルールが、Ansible、Terraform、GitOpsの3か所で同じ形で現れることを整理しました。本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** で示した3つの経路が、第2部・第3部の仕組みを入れても残っていること、承認、昇格、revertというGitOpsの仕組みそのものが新しい食い違いを生むことを示しました。そのうえで、「main」「最後に適用したコミット」「実環境」の3つの状態を区別し、マージ済みで未適用の状態と、コンテナの属性の手動変更を実機で作って、どちらもツールの表示は「差分あり」でも、記録と照らし合わせれば、未適用の差分とドリフトに分けられることを確かめました。最後に、検出できる範囲と検出できない範囲を整理し、この整理がクラウドのプロバイダーでも変わらないことを示しました。

今回から、第4部「ドリフト検知と自動収束」に入りました。第4部では、**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** の防ぐ・検知する・修正するを、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)** までに、GitOpsのパイプラインの上で組み立てていきます。

**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** では、このうちの「検知する」を扱います。今回確かめたとおり、mainのコードで`plan`や`--check`を実行すると、結果には未適用の差分とドリフトが混ざります。ドリフトだけを見るには、環境ごとに最後に適用したコミットのコードで、実環境と比べる必要があります。また、今のパイプラインは変更のときにしか動かず、ホステッドランナーで動く既存の「Drift Check」は、動き続けている環境を見ていません。次回は、最後に適用したコミットと実環境を定期的に比べ、結果を「差分なし」「差分あり」「検知失敗」の3つに分ける検知を作り、検知そのものが止まったことを、別の場所から確かめる仕組みを扱います。**[Ansible×Terraformシリーズ第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** の定期実行による検知を、稼働し続ける環境に向けて深掘りする回です。

**[次回：第18回：定期実行でドリフトを自動検知する](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)　｜　[次の記事：【GitOps編】第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第4部まとめブログ：ドリフトの区別・検知・収束・例外・予防を「最後に適用したコミット」でつなぐ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 11. 連載一覧：「Ansible×TerraformをGitOpsで回す」

### 第4部：ドリフト検知と自動収束

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)**|GitOps環境でドリフトはなぜ起きるのか|ドリフトシリーズの、記述されていない要素は比較の対象にならないというルールが、Ansible・Terraform・GitOpsの3か所で現れることを示す。第1回の3つの経路が第2部・第3部を経ても残ることと、承認・昇格・revertが生む食い違いを整理する。「main」「最後に適用したコミット」「実環境」の3つの状態を区別し、マージ済みで未適用の状態とコンテナの属性の手動変更を実機で作って、未適用の差分とドリフトを記録で見分ける。第4部の初回。|
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**|定期実行でドリフトを自動検知する|「最後に適用したコミット」と実環境を比べ、結果を「差分なし」「差分あり」「検知失敗」の3つに分ける定期検知を作る。検知が止まったことを、ホステッドランナーから別に確認する。Ansible×Terraformシリーズ第37回の深掘り版として位置づける。|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**|ドリフトを検知したら自動収束させる|収束先を承認済みの状態（最後に適用したコミット）に限定し、承認ゲートと矛盾しない自動収束を作る。再生成・削除・再作成や検知失敗は人に返し、収束しないPlaybookによる無限の収束を止める。|
|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)**|緊急対応の手動変更とGitOpsを両立させる|障害対応で加えた手動変更を自動収束が元に戻してしまう問題を扱う。Gitを経由する高速経路と、自動収束の一時停止・バックポートを、記録と期限を持つ「設計された例外経路」として組み込む。|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**|検知できないドリフトを減らす：管理対象の範囲を広げる設計|検知も自動収束もできない「記述・記録されていない乖離」を扱い、ドリフトシリーズ第4回の「防ぐ」をGitOps上で実装する。管理外のものを実際の状態とPlaybook・tfstateとの突き合わせで洗い出し、「取り込む」「削除する」「管理外と宣言する」に振り分けてすべてをGitに記録する。第4部・シリーズの最終回。|

---

[↑ 目次に戻る](#-目次)

---