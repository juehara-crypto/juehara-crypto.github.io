---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第20回：緊急対応の手動変更とGitOpsを両立させる'
description: '障害対応で加えた手動変更を、自動収束がドリフトとして元に戻してしまう問題を、GitOpsのパイプラインの上で扱う。Gitを経由する高速経路では、昇格の順序だけを記録付きで短縮し、ガードレールと保存したplanの適用は短縮しない。Gitを経由しない手動変更では、自動収束を理由と期限を持つ形で一時停止し、一時停止中も検知とIssueへの記録を続け、期限が来れば解除の操作なしに通常の自動収束へ戻ることを確かめる。手で加えた変更は、期限内に手動変更と同じ範囲だけをGitに書き戻すか、捨てるかを決める。戻さなかった変更のうち、Playbookが管理しているものは自動収束で戻り、管理していないものは残ることを確かめる。場当たり的な回避と設計された例外経路の違いを、記録・期限・戻し方の有無で整理する回。'
pubDate: 2026-10-30
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'ドリフト', '緊急対応']
seriesId: 'ansible-gitops-part4'
seriesNo: 20
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/'
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
2. [緊急対応の板挟み](#2-緊急対応の板挟み)
3. [Gitを経由する高速経路](#3-gitを経由する高速経路)
4. [自動収束を一時停止する](#4-自動収束を一時停止する)
5. [一時停止そのものがドリフトの原因になる](#5-一時停止そのものがドリフトの原因になる)
6. [手動変更をGitに戻す](#6-手動変更をgitに戻す)
7. [場当たり的な回避と設計された例外の違い](#7-場当たり的な回避と設計された例外の違い)
8. [クラウドでも同じ設計で両立できる](#8-クラウドでも同じ設計で両立できる)
9. [まとめ](#9-まとめ)
10. [次回予告](#10-次回予告)
11. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#11-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

TerraformとAnsibleのパイプラインに、ドリフトを自動で戻す仕組みを入れていて、

* 障害が起きたので、サーバーに入って設定を手で直した
* サービスは復旧した
* よって、障害対応は終わった

と考えていないでしょうか。

GitOpsを扱う記事の多くは、「すべての変更はGitを通す」という原則を示すところで終わっています。障害対応のように、原則どおりの手順を踏んでいられない場面を、パイプラインの中にどう組み込むかは、あまり扱われていません。自動収束を持つパイプラインで障害対応を行うと、次のような場面にぶつかります。

* 手で直した設定が、次の自動収束で元に戻り、障害が再発した
* 急ぐために、チェックを外してマージした
* 自動収束を止めたまま戻し忘れ、その間に起きたドリフトが放置された
* 手で直した内容がGitに戻されず、何を変えたのかを誰も覚えていない

これらは、手順の守り方や、担当者の間の連絡の問題に見えます。共通しているのは、障害対応のために通常の経路を外れるとき、誰が、いつ、なぜ外れたのか、そしていつ通常の経路に戻るのかが、どこにも残らないまま行われている点です。

障害対応の手動変更とAnsibleの関係は、**[「Ansibleは冪等なのに、なぜサーバは壊れていくのか」](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)**（以下、ドリフトシリーズ）で扱いました。

|回|扱った内容|
|---|---|
|**[ドリフトシリーズ第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)**|障害対応で手で書き換えた`worker_connections`が、`template`のPlaybookの次の実行で、元の値に黙って戻されることを確かめた。実行結果の`changed`からは、戻し忘れの修正なのか、意図した緊急対応の無効化なのかを区別できないとした。手動変更の問題の本質は、次にAnsibleが実行されるまで気づかれない時間的な空白にあると整理した|

TerraformとAnsibleを組み合わせた環境での手動変更は、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも扱いました。

|回|扱った内容|
|---|---|
|**[Ansible×Terraformシリーズ第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**|障害対応を想定して、コンテナの中の設定ファイルを手で書き換えた。`terraform plan`は前後とも差分なしで、`--check --diff`だけが差分を示した。その差分が戻し忘れなのか意図した緊急対応なのかは出力からは判別できないため、機械的に同期せず、人が内容を確かめてから同期する工程を組み込む必要があると整理した|

本シリーズでは、GitHubの非公開リポジトリに置いたTerraformとAnsibleのコードを、GitHub Actionsのワークフローを通してインフラに届けるパイプラインを作ってきました。ワークフローは、操作対象と同じネットワークに置いたself-hostedランナーで動き、操作対象は、dev、stg、prodの3つの環境に分けたDockerのコンテナです。この回で前提にする仕組みは、次のとおりです。

|仕組み|置き場所|役割|
|---|---|---|
|「GitOps Pipeline」|GitHub Actionsのワークフロー（self-hostedランナー）|プルリクエストで、`terraform plan`とAnsibleの確認モードを実行する。マージで、環境ごとにplanを保存し、承認待ちを作る|
|「GitOps Apply」|GitHub Actionsのワークフロー（self-hostedランナー、手動で起動）|選んだ環境の承認待ちを、入口の確認（昇格の順序、プルリクエストを通ったか、ガードレールの結果、planの判定）を通ったときだけ適用する。手動の起動を、承認の操作とみなす|
|「Drift Detect」|GitHub Actionsのワークフロー（self-hostedランナー、毎日のスケジュールと手動の起動）|環境ごとに最後に適用したコミットのコードで、実環境との差分を検知する。手動の起動で収束を有効にしたときは、検知した差分を自動で戻す|
|「Drift Detect Watch」|GitHub Actionsのワークフロー（ホステッドランナー）|「Drift Detect」が最後に成功した時刻を確かめ、検知が止まったことを知らせる|
|最後に適用したコミットの記録|tfstateと同じPostgreSQLの表（`gitops.applied`）|環境ごとに、どのコミットを、どの実行で適用したかを残す|
|承認待ち|ランナーのホームディレクトリ（`~/gitops-pending/`）|マージで作ったplanとコミットを、承認されるまで環境ごとに置いておく|

これらの仕組みは、これまでの回で、次の整理とともに積み上げてきました。

|部|回|扱った内容|
|---|---|---|
|第2部|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**|マージで作ったplanを承認待ちとして保存し、手動の起動を承認とする承認ゲートを作った。承認を待っている間に、障害対応などで手元から先に適用すると、保存したplanは`Saved plan is stale`で拒否されることを確かめた。ゲートが止めるのは内容ではなくタイミングだと整理した|
|第2部|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**|ansible-lintとMoleculeを、承認の材料から適用の内容を予測できること、何度実行しても収束することという、パイプラインの前提を守るガードレールとして位置づけ、承認ゲートの入口でその結果を確かめる構成にした|
|第2部|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|dev、stg、prodの順にしか適用できない昇格の仕組みを作り、環境ごとに「最後に適用したコミット」を記録した|
|第2部|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**|`git revert`によるロールバックも、新しいコミットを同じパイプラインに通して前に進める操作だと整理した。適用できるのは常に最新のmainで、途中のコミットを飛ばした環境では、消す変更が当たらないまま残ることを確かめた|
|第2部|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**|ロックの解除、`allow_destroy`の付け直し、チェックのステップの削除のように、停止を回避する操作は、ガードレールを壊す操作だと整理した。設計どおりに止まったときに直すのは、パイプラインではなく手順である。手元から適用した変更は、最後に適用したコミットの記録に入らず、パイプラインの判定に現れないまま残ることも確かめた|
|第4部|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**|GitHub Actionsのワークフロー「Drift Detect」として、環境ごとに最後に適用したコミットのコードで実環境を定期的に比べる検知を作った。あわせて、検知が止まったことに気づく確認役のワークフロー「Drift Detect Watch」と、検知の結果を環境ごとに1つのIssueに残す仕組みを加えた。緊急対応の手動変更は、パイプラインの外からstateに触れる経路として、今の構成にも残ると整理した|
|第4部|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**|「Drift Detect」に、自動収束を加えた。収束先を環境ごとに最後に適用したコミットに限り、検知の時点で保存したplanで、検知した差分だけを戻す。収束しないPlaybookは、ランナーのホームディレクトリに止める印のファイルを置き、人が消すまでその環境の自動収束を止める形にした。そのうえで、障害対応で加えた再起動の方針の変更と「戻さないこと」と書き残した1行が、1回の実行で2つとも戻され、Issueも作られず、戻されたことが実行のログにしか残らないことを確かめた|

**[ドリフトシリーズ第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)** で整理した時間的な空白は、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** の自動収束によって、次の実行までの短い時間に詰められました。その結果、障害対応で意図して加えた変更も、次の実行で確実に戻されるようになりました。**[Ansible×Terraformシリーズ第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** で組み込むとした「人が内容を確かめてから同期する工程」は、自動収束を入れた時点で、パイプラインから外れています。一方で、障害対応のたびに、プルリクエスト、ガードレール、承認ゲート、dev、stg、prodの昇格をすべて通していては、復旧が間に合わないことがあります。

第20回となる今回は、障害対応とGitOpsのパイプラインを両立させる設計を扱います。まず、障害対応が、これまでに作ったパイプラインとどうぶつかるのかを整理します。次に、障害対応の変更でもGitを経由できる高速経路として、昇格の順序だけを短縮し、ガードレールと保存したplanの適用は短縮しない経路を作ります。そのうえで、Gitを経由せずに手で変えるときのために、自動収束を、記録と期限を持つ形で一時停止する仕組みを作り、一時停止そのものが新しいドリフトの原因になることへの手当てを確かめます。続けて、手で加えた変更をGitに戻す流れと、戻さなかった変更のうちPlaybookが管理しているものが自動収束で元に戻ることを確かめます。さらに、場当たり的な回避と、この回で作る例外経路の違いを整理し、最後に、この設計がクラウドのプロバイダーでも変わらないことを示します。検知も自動収束もできない範囲そのものを狭める設計は、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)** で扱います。

正確に言うと、**緊急対応は、GitOpsの例外として外に置くものではありません。誰が、いつ、なぜ通常の経路を外れ、いつ戻るのかを、記録と期限で決めた「設計された例外経路」として、パイプラインの中に組み込む必要があります**。この回で扱う問いは、「障害対応を、GitOpsの『唯一の真実』を崩さずに成立させるには、どんな例外経路が必要なのか」です。

次のセクションでは、障害対応が、これまでに作ったパイプラインとどうぶつかるのかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 緊急対応の板挟み

障害対応で設定を変えるときに、これまでに作ったパイプラインを通す場合と、通さずに手で変える場合で、それぞれ何が起きるのかを整理します。

### 通常の経路は、段階が多い

これまでの回で作ったパイプラインでは、1つの変更をprodに届けるまでに、次の段階を順に通ります。

|段階|動くもの|この段階が守っているもの|
|---|---|---|
|プルリクエストの確認|「GitOps Pipeline」の確認の実行（`terraform plan`、Ansibleの確認モード、ansible-lint、Molecule、Terraformの静的なチェック）|レビューする人が、変更の内容とその影響を見られること。チェックを通らない変更を見つけること（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**）|
|マージ|「GitOps Pipeline」のマージの実行|マージした後のmainから、3つの環境それぞれのplanを保存し、承認待ちを作ること（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**）|
|devへの適用|「GitOps Apply」をdevで起動|入口の確認を通ったときだけ、保存したplanとそのコミットのPlaybookを適用すること（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）|
|stgへの適用|「GitOps Apply」をstgで起動|devに同じコミットを適用し終えていること（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**）|
|prodへの適用|「GitOps Apply」をprodで起動|stgに同じコミットを適用し終えていること（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**）|

prodに届けるには、プルリクエストを作ってから、確認の実行とマージの実行の完了を待ち、「GitOps Apply」をdev、stg、prodの順に3回起動して、それぞれの完了を待つ必要があります。どの段階も、変更が誤っていたときにprodへ届く前に止めるためのものです。一方で、prodで障害が起きているときには、この段階の数が、そのまま復旧までの時間になります。

### 手で直すと、戻されるか、記録に残らない

段階を待たずに、操作対象を手で直した場合はどうなるかを、これまでの回の結果から並べます。

|手で変えたもの|その後に起きること|確かめた回|
|---|---|---|
|Ansibleが管理しているファイル|収束を有効にした「Drift Detect」の1回の実行で、元に戻された。担当者が書き残した「戻さないこと」という1行も、ドリフトとして消された|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション8|
|Terraformが管理している属性（再起動の方針）|同じ実行で、その場の更新として元に戻された|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション8|
|手元から実行した`terraform apply`|承認を待っていたplanは、`Saved plan is stale`で適用できなくなった。手元からの適用は、最後に適用したコミットの記録に入らなかった|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション5、**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション3|

**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** の「Drift Detect」は、スケジュール実行では収束を行わず、手動で起動して収束を有効にしたときだけ、差分を戻します。それでも、手で直した変更が残り続けるわけではありません。「GitOps Apply」は、Terraformだけの変更を適用するときも、Ansibleの本実行をPlaybookの全体に対して行います（**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション3）。そのため、その環境に次の変更を適用した時点で、Playbookが管理しているものは元に戻ります（この経路は、仕組みからの導出で、この回では確かめていません）。収束を有効にしていなければ、戻されるまでの間、「Drift Detect」は毎日その環境を差分ありと判定し、その環境のIssueを開いたまま書き換え続けます（**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** のセクション6）。

どちらの場合も、戻される変更が障害対応のために意図して加えたものであることは、パイプラインのどこにも記録されていません。**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション8では、自動収束で戻った後の再検知が差分なしだったため、Issueは作られず、戻されたことは実行のログにしか残りませんでした。

### 今あるのは、自動で置かれる止める印だけ

今のパイプラインで、特定の環境の自動収束を止める仕組みは、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション6で作った止める印だけです。ランナーのホームディレクトリに置くファイルで、これがある環境では、「Drift Detect」は検知とIssueの記録だけを続け、自動収束を飛ばします。

ただし、この印は、収束の後の再検知で差分が残ったときに、パイプラインが自動で置くものです。中身は、比べたコミットと実行のURLだけで、誰が、なぜ止めたのか、いつまで止めるのかは書かれていません。人が先に置いて、障害対応の手動変更を守る使い方は、想定していません。

### 2つの経路と、共通の条件

障害対応では、通常の経路を全部待つと遅く、通常の経路を外れて手で直すと、戻されるか、何も残りません。この板挟みに対して、この回では、障害対応の変更の入り方を2つに分けて設計します。

|経路|変更の入り方|扱うセクション|
|---|---|---|
|Gitを経由する高速経路|変更はプルリクエストとしてmainに入れ、通常の経路の一部の段階だけを短縮して、prodに先に届ける|**[セクション3](#3-gitを経由する高速経路)**|
|Gitを経由しない手動変更|操作対象を手で直し、その間は自動収束を止めておき、後から変更をGitに戻すか、捨てるかを決める|**[セクション4](#4-自動収束を一時停止する)** 〜 **[セクション6](#6-手動変更をgitに戻す)**|

どちらの経路にも、次の2つを条件として課します。

* 誰が、いつ、なぜ通常の経路を外れたのかが、記録に残ること
* 期限が来たら、通常の経路に戻ること

記録がなければ、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション8と同じく、何が起きたのかが後から分かりません。期限がなければ、通常の経路を外れた状態が、そのまま新しいドリフトになります。スケジュール実行で収束を有効にするかどうかも、手動変更のために自動収束を止める仕組みができてから、**[セクション5](#5-一時停止そのものがドリフトの原因になる)** で扱います。

次のセクションでは、Gitを経由する高速経路を作ります。

---

[↑ 目次に戻る](#-目次)

---

## 3. Gitを経由する高速経路

障害対応の変更でもGitを経由できるように、通常の経路のうち昇格の順序だけを、記録を残す形で短縮できる経路を作ります。

### 短縮してよいのは、昇格の順序だけ

**[セクション2](#2-緊急対応の板挟み)** で並べた段階のうち、緊急時にどれを短縮してよいかを、それぞれの段階が守っているものから決めます。

|段階|守っているもの|緊急時|
|---|---|---|
|プルリクエスト|変更がGitに残り、レビューできること。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** から、適用の入口で、適用する範囲のコミットがすべてプルリクエストのマージであることを確かめている|短縮しない。Gitを経由する経路そのもの|
|ガードレール（ansible-lint、Molecule、Terraformの静的なチェック）|承認の材料から適用の内容を予測できること、何度実行しても収束すること（**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**）|短縮しない。外すと、承認の材料と、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** の自動収束の前提が、同時に崩れる|
|planの判定と保存したplanの適用|削除や作り直しを、人が明示しない限り通さないこと。レビューした計画だけを適用し、前提が変われば止まること（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**）|短縮しない。障害の最中ほど、意図しない作り直しの影響が大きい|
|昇格の順序（dev→stg→prod）|prodの前に、dev・stgで同じコミットを本実行して確かめること（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**）|**短縮してよい**。ただし、短縮したことを記録に残す|

ガードレールにかかる時間は、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** の検証で、ansible-lintが20秒前後、Moleculeが44秒でした。短縮しても、障害対応の時間はほとんど変わりません。一方、昇格の順序は、dev、stgへの適用と、その間の確認を待つ段階で、prodに届くまでの時間の多くを占めます。

昇格の順序を短縮すると、失うものもあります。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4で確かめたとおり、Ansibleの確認モードの出力は予測で、本実行で何が変わるかを保証しません。dev・stgで本実行してから進む順序は、その予測の外にある変更を、prodの前に見つける機会でもありました。順序を短縮すると、prodが、その変更を初めて本実行する環境になります。そのため、短縮したこと自体を、後から追える形で残します。

### 例外の記録を、どこに残すか

GitHub Actionsのワークフロー「GitOps Apply」は、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** から、適用した結果をPostgreSQLの表`gitops.applied`に残しています。ただし、この表は、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の検知と **[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** の自動収束が、比べるコミットを読む場所でもあります。列を足して意味を変えるのは避け、同じPostgreSQLに、通常の経路を外れたことだけを残す表`gitops.exceptions`を新しく作ります。

|列|内容|
|---|---|
|`env`|環境|
|`kind`|例外の種類。このセクションでは`promotion-skip`（昇格の順序を飛ばした）だけ|
|`commit_sha`|適用しようとしたコミット|
|`reason`|理由。空は受け付けない|
|`requested_by`|「GitOps Apply」を起動したGitHubのユーザー|
|`run_url`|「GitOps Apply」の実行のURL|
|`created_at`|記録した時刻|

### ■ 検証内容：例外の記録の表を作る

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
psql "$PG_CONN_STR" -X -v ON_ERROR_STOP=1 <<'EOF'
CREATE TABLE gitops.exceptions (
  id           bigserial PRIMARY KEY,
  env          text NOT NULL CHECK (env IN ('dev', 'stg', 'prod')),
  kind         text NOT NULL CHECK (kind IN ('promotion-skip')),
  commit_sha   text NOT NULL,
  reason       text NOT NULL CHECK (length(btrim(reason)) > 0),
  requested_by text NOT NULL,
  run_url      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
EOF
echo "create_exit_code=$?"
psql "$PG_CONN_STR" -X -c '\d gitops.exceptions'
```

**▼ 実行結果**

```plaintext
CREATE TABLE
create_exit_code=0
                                           Table "gitops.exceptions"
    Column    |           Type           | Collation | Nullable |                    Default
--------------+--------------------------+-----------+----------+-----------------------------------------------
 id           | bigint                   |           | not null | nextval('gitops.exceptions_id_seq'::regclass)
 env          | text                     |           | not null |
 kind         | text                     |           | not null |
 commit_sha   | text                     |           | not null |
 reason       | text                     |           | not null |
 requested_by | text                     |           | not null |
 run_url      | text                     |           | not null |
 created_at   | timestamp with time zone |           | not null | now()
Indexes:
    "exceptions_pkey" PRIMARY KEY, btree (id)
Check constraints:
    "exceptions_env_check" CHECK (env = ANY (ARRAY['dev'::text, 'stg'::text, 'prod'::text]))
    "exceptions_kind_check" CHECK (kind = 'promotion-skip'::text)
    "exceptions_reason_check" CHECK (length(btrim(reason)) > 0)
```

### ■ 検証内容：「GitOps Apply」に緊急時の入力を加える

「GitOps Apply」に、`emergency`と`reason`の2つの入力を足し、ステップ「Check promotion order」を書き換えました。

**▼ 実行結果**（`git diff`、「GitOps Apply」の変更）

```plaintext
@@ -19,6 +19,14 @@ on:
         description: '削除と作り直しを含むplanの適用を許可する（stgとprodで使う。devでは入力なしで許可する）'
         type: boolean
         default: false
+      emergency:
+        description: '緊急時に、前の環境への適用を待たずに適用する（昇格の順序の確認だけを飛ばし、記録に残す。理由の入力が必要）'
+        type: boolean
+        default: false
+      reason:
+        description: '緊急時に適用する理由（emergencyのときに必須）'
+        type: string
+        default: ''

 concurrency:
   group: gitops-pipeline
@@ -87,6 +95,8 @@ jobs:
       - name: Check promotion order
         env:
           PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
+          EMERGENCY: ${{ inputs.emergency }}
+          REASON: ${{ inputs.reason }}
         run: |
           case "$TARGET_ENV" in
             dev)
@@ -98,11 +108,20 @@ jobs:
           esac
           prev_applied=$(.github/scripts/applied.sh last "$prev")
           echo "last applied ($prev): $prev_applied"
-          if [ "$prev_applied" != "$GITHUB_SHA" ]; then
+          if [ "$prev_applied" = "$GITHUB_SHA" ]; then
+            echo "$GITHUB_SHA has been applied to $prev"
+            exit 0
+          fi
+          if [ "$EMERGENCY" != "true" ]; then
             echo "::error::$GITHUB_SHA has not been applied to $prev yet"
             exit 1
           fi
-          echo "$GITHUB_SHA has been applied to $prev"
+          if [ -z "$(printf '%s' "$REASON" | tr -d '[:space:]')" ]; then
+            echo "::error::emergency requires a reason"
+            exit 1
+          fi
+          .github/scripts/exception.sh record "$TARGET_ENV" promotion-skip "$GITHUB_SHA" "$REASON" "$GITHUB_ACTOR" "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
+          echo "::warning::promotion order skipped by emergency: $GITHUB_SHA has not been applied to $prev (requested_by=$GITHUB_ACTOR)"
       - name: Check commits came from pull requests
         env:
           GH_TOKEN: ${{ github.token }}
```

変えた内容は、次のとおりです。

* 前の環境に同じコミットを適用し終えていれば、これまでどおり通す
* 適用し終えていないときは、`emergency`が有効で、`reason`が空白だけでない場合に限り、`gitops.exceptions`に1行を記録し、警告を出して通す。それ以外は、これまでどおり止める
* `reason`の値は、スクリプトの中に直接埋め込まず、環境変数で渡す。入力に記号が含まれていても、シェルのコマンドとして解釈されないようにするため
* 記録するのは、この時点。後のステップ（プルリクエストの確認、ガードレールの確認、planの判定）で止まっても、例外を使おうとしたことは残る
* ほかのステップと、`terraform-apply`、`ansible-apply`、`record-applied`のジョブには手を入れていない

記録は、新しく作ったスクリプト`.github/scripts/exception.sh`で行います。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** の`applied.sh`と同じく、値は`psql`の変数で渡します。

**▼ 実行結果**（`cat -n .github/scripts/exception.sh`）

```plaintext
     1  #!/usr/bin/env bash
     2  # 通常の経路を外れた例外を、PostgreSQLのgitops.exceptionsで読み書きする
     3  #   exception.sh record <環境> <種類> <コミット> <理由> <起動した人> <実行のURL>  例外を1行記録する
     4  #   exception.sh list [件数]                                                       直近の記録を表示する（既定10件）
     5  # 終了コード 0=成功、2=使い方の誤り
     6  set -euo pipefail
     7
     8  usage() {
     9    echo "usage: exception.sh record <dev|stg|prod> <kind> <commit> <reason> <requested_by> <run_url> | exception.sh list [limit]" >&2
    10    exit 2
    11  }
    12
    13  [ $# -ge 1 ] || usage
    14
    15  case "$1" in
    16    record)
    17      [ $# -eq 7 ] || usage
    18      case "$2" in
    19        dev|stg|prod) ;;
    20        *) usage ;;
    21      esac
    22      id=$(printf '%s\n' "INSERT INTO gitops.exceptions (env, kind, commit_sha, reason, requested_by, run_url) VALUES (:'env', :'kind', :'sha', :'reason', :'by', :'url') RETURNING id;" \
    23        | psql "$PG_CONN_STR" -X -q -A -t -v ON_ERROR_STOP=1 -v env="$2" -v kind="$3" -v sha="$4" -v reason="$5" -v by="$6" -v url="$7")
    24      echo "exception recorded: id=$id env=$2 kind=$3 commit=$4 requested_by=$6"
    25      ;;
    26    list)
    27      [ $# -le 2 ] || usage
    28      limit="${2:-10}"
    29      case "$limit" in
    30        ''|*[!0-9]*) usage ;;
    31      esac
    32      printf '%s\n' "SELECT id, env, kind, left(commit_sha, 7) AS commit, reason, requested_by, created_at FROM gitops.exceptions ORDER BY id DESC LIMIT :limit;" \
    33        | psql "$PG_CONN_STR" -X -v ON_ERROR_STOP=1 -v limit="$limit"
    34      ;;
    35    *)
    36      usage
    37      ;;
    38  esac
```

この変更をプルリクエスト（PR#117）にし、確認の実行（「GitOps Pipeline」の実行#190）で`changes`ジョブだけが動いたことを確かめて、マージしました（マージコミット`cd8b2bf`、「GitOps Pipeline」の実行#191）。

### ■ 検証内容：prodに先に届ける変更をマージする

prodに先に届ける変更として、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** までと同じく、`/etc/gitops-env.conf`に1行を足しました（Ansibleだけの変更）。

**▼ 実行結果**（`git diff`）

```plaintext
@@ -10,4 +10,5 @@
       gitops18=pending-detect
       gitops18=promote-check
       gitops19=pending-converge
+      gitops20=fast-path
     mode: "0644"
```

この変更をプルリクエスト（PR#118）にしました。確認の実行（「GitOps Pipeline」の実行#192）では、`ansible-lint`、`molecule`、`ansible-check`が成功しています。マージすると（マージコミット`4a53c54`、「GitOps Pipeline」の実行#193）、3環境の承認待ちが作られました。

**実行コマンド**

```plaintext
for e in dev stg prod; do echo "== $e"; ls -l ~/gitops-pending/$e; for f in commit terraform ansible; do echo "$f=$(cat ~/gitops-pending/$e/$f)"; done; done
```

**▼ 実行結果**

```plaintext
== dev
total 12
-rw------- 1 control control  5 Oct 30 22:38 ansible
-rw------- 1 control control 41 Oct 30 22:38 commit
-rw------- 1 control control  6 Oct 30 22:38 terraform
commit=4a53c5461246ed676e87330c8884d8551db98244
terraform=false
ansible=true
== stg
（途中省略：devと同じ内容）
== prod
（途中省略：devと同じ内容）
```

この時点で、3環境の最後に適用したコミットは`cdd5e6a`です。

### ■ 検証内容：緊急時の入力なし、理由なしで、prodに適用しようとする

「GitOps Apply」を、`environment`を`prod`にし、`emergency`を外して起動しました（「GitOps Apply」の実行#107）。続けて、`emergency`だけを有効にし、`reason`を空のまま起動しました（「GitOps Apply」の実行#108）。

**▼ 実行結果**（「GitOps Apply」の実行#107、`verify`ジョブのステップ「Check promotion order」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  TARGET_ENV: prod
  PG_CONN_STR: ***
  EMERGENCY: false
  REASON: 
last applied (stg): cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16
##[error]4a53c5461246ed676e87330c8884d8551db98244 has not been applied to stg yet
##[error]Process completed with exit code 1.
```

**▼ 実行結果**（「GitOps Apply」の実行#108、`verify`ジョブのステップ「Check promotion order」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  TARGET_ENV: prod
  PG_CONN_STR: ***
  EMERGENCY: true
  REASON: 
last applied (stg): cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16
##[error]emergency requires a reason
##[error]Process completed with exit code 1.
```

どちらも`verify`ジョブで止まり、後のジョブはすべてスキップされました。

**実行コマンド**

```plaintext
ls ~/gitops-pending
.github/scripts/exception.sh list
```

**▼ 実行結果**

```plaintext
dev  prod  stg
 id | env | kind | commit | reason | requested_by | created_at
----+-----+------+--------+--------+--------------+------------
(0 rows)
```

緊急時の入力がなければ、これまでどおり順序の確認で止まり、理由がなければ、緊急時の入力があっても止まりました。どちらも記録の手前で止まっているため、`gitops.exceptions`には何も残っていません。3環境の承認待ちも残っています。

### ■ 検証内容：緊急時の入力と理由を付けて、prodに先に適用する

「GitOps Apply」を、`environment`を`prod`、`emergency`を有効にし、`reason`に「障害対応の確認（第20回）：prodに先にgitops20=fast-pathを適用する」と入れて起動しました（「GitOps Apply」の実行#109）。`verify`、`ansible-apply`、`record-applied`が成功し、Terraformの変更がないため`terraform-apply`はスキップされました。

**▼ 実行結果**（「GitOps Apply」の実行#109、`verify`ジョブのステップ「Check promotion order」「Check commits came from pull requests」「Check guardrail results」から抜粋）

```plaintext
（ステップ「Check promotion order」）
（途中省略：実行したスクリプト、シェルの表示）
  TARGET_ENV: prod
  PG_CONN_STR: ***
  EMERGENCY: true
  REASON: 障害対応の確認（第20回）：prodに先にgitops20=fast-pathを適用する
last applied (stg): cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16
exception recorded: id=1 env=prod kind=promotion-skip commit=4a53c5461246ed676e87330c8884d8551db98244 requested_by=juehara-crypto
##[warning]promotion order skipped by emergency: 4a53c5461246ed676e87330c8884d8551db98244 has not been applied to stg (requested_by=juehara-crypto)
（ステップ「Check commits came from pull requests」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
last applied (prod): cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16
4a53c5461246ed676e87330c8884d8551db98244: merge of pull request #118
cd8b2bf4babef77d75a41aeabf57524b82252a24: merge of pull request #117
（ステップ「Check guardrail results」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
ansible-lint: success
molecule: success
```

**▼ 実行結果**（「GitOps Apply」の実行#109、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
（途中省略：PLAYの表示、ほかのタスクはok）
TASK [common_setup : 環境の名前を書いたファイルを配置] *************************
--- before: /etc/gitops-env.conf
+++ after: /etc/gitops-env.conf
@@ -4,3 +4,4 @@
 gitops18=pending-detect
 gitops18=promote-check
 gitops19=pending-converge
+gitops20=fast-path

changed: [target-node1]
（途中省略：target-node2とtarget-node3の同じ差分、ほかのタスクはok）
target-node1               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**▼ 実行結果**（「GitOps Apply」の実行#109、`record-applied`ジョブから抜粋）

```plaintext
last applied (prod): 4a53c5461246ed676e87330c8884d8551db98244
（途中省略）
pending approval for prod cleared
```

手元で、記録と実環境を確かめます。

**実行コマンド**

```plaintext
ls ~/gitops-pending
.github/scripts/exception.sh list
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 4;'
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n tail -1 /etc/gitops-env.conf; done
```

**▼ 実行結果**

```plaintext
dev  stg
 id | env  |      kind      | commit  |                              reason                              |  requested_by  |          created_at
----+------+----------------+---------+------------------------------------------------------------------+----------------+-------------------------------
  1 | prod | promotion-skip | 4a53c54 | 障害対応の確認（第20回）：prodに先にgitops20=fast-pathを適用する | juehara-crypto | 2026-10-30 23:06:31.669501+00
(1 row)

 id | env  |                commit_sha
----+------+------------------------------------------
 73 | prod | 4a53c5461246ed676e87330c8884d8551db98244
 72 | prod | cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16
 71 | stg  | cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16
 70 | dev  | cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16
(4 rows)

== dev-node1
gitops19=pending-converge
== stg-node1
gitops19=pending-converge
== target-node1
gitops20=fast-path
== target-node2
gitops20=fast-path
== target-node3
gitops20=fast-path
```

### ■ 結果

3回の起動を並べると、次のとおりです。

|項目|「GitOps Apply」の実行#107|「GitOps Apply」の実行#108|「GitOps Apply」の実行#109|
|---|---|---|---|
|`emergency`|なし|あり|あり|
|`reason`|空|空|あり|
|「Check promotion order」|`has not been applied to stg yet`で止まる|`emergency requires a reason`で止まる|例外として記録し、警告を出して通る|
|プルリクエストの確認、ガードレールの確認|動いていない|動いていない|通常どおり動き、通った|
|`gitops.exceptions`|記録なし|記録なし|id 1を記録|
|prodへの適用|なし|なし|3台に適用（`changed=1`）|

緊急時の経路で飛ばしたのは、stgに同じコミットを適用し終えたかの確認だけです。プルリクエストの確認は、prodの最後に適用したコミット`cdd5e6a`から`4a53c54`までの、PR#118とPR#117の2つのマージを確かめ、ガードレールの確認も通常どおり行われています。

`gitops.exceptions`には、どの環境で、どのコミットを、誰が、なぜ、いつ、通常の順序を飛ばして適用したかが残りました。どの実行で行ったかも、`run_url`の列に残っています。`gitops.applied`のid 73は、ほかの行と同じ形の記録で、この表だけを見ても、通常の順序を飛ばしたかどうかは分かりません。例外を使ったことは、`gitops.exceptions`の側で分かります。

### ■ 検証内容：prodだけが先に進んだ状態で検知する

prodだけが`4a53c54`、dev・stgが`cdd5e6a`という状態で、「Drift Detect」を、`compare_with`を`last-applied`、`converge`を無効にして起動しました（「Drift Detect」の実行#41）。

**▼ 実行結果**（「Drift Detect」の実行#41、`detect`ジョブから抜粋）

```plaintext
  COMPARE_WITH: last-applied
  CONVERGE: false
（途中省略：環境変数の表示）
== dev
compare_with=last-applied ref=cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16
（途中省略：planは差分なし）
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== stg
compare_with=last-applied ref=cdd5e6afec9f97ba7ef478d3f0de9ffb46f7bd16
（途中省略：planは差分なし）
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== prod
compare_with=last-applied ref=4a53c5461246ed676e87330c8884d8551db98244
（途中省略：planは差分なし）
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（ステップ「Report to issues」）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
no open issue: [drift-detect] prod
```

**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** のセクション7と同じく、各環境は、それぞれが最後に適用したコミットのコードと比べられました。prodだけが先に進んでいても、dev・stgに未適用の1行は、ドリフトとして報告されていません。高速経路で順序を飛ばしても、検知の側に誤報は生まれませんでした。

### ■ 検証内容：dev・stgを、通常の経路で追いつかせる

緊急時の入力は使わずに、「GitOps Apply」をdev（「GitOps Apply」の実行#110）、stg（「GitOps Apply」の実行#111）の順に起動しました。どちらも、`verify`、`ansible-apply`、`record-applied`が成功しています。

**▼ 実行結果**（「GitOps Apply」の実行#111、`verify`ジョブのステップ「Check promotion order」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  TARGET_ENV: stg
  PG_CONN_STR: ***
  EMERGENCY: false
  REASON: 
last applied (dev): 4a53c5461246ed676e87330c8884d8551db98244
4a53c5461246ed676e87330c8884d8551db98244 has been applied to dev
```

dev-node1とstg-node1にも`+gitops20=fast-path`が入り、どちらも`changed=1`でした。手元で、記録を確かめます。

**実行コマンド**

```plaintext
ls -la ~/gitops-pending
.github/scripts/exception.sh list
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct 30 23:17 .
drwxr-x--- 14 control control 4096 Oct 30 22:39 ..
 id | env  |      kind      | commit  |                              reason                              |  requested_by  |          created_at
----+------+----------------+---------+------------------------------------------------------------------+----------------+-------------------------------
  1 | prod | promotion-skip | 4a53c54 | 障害対応の確認（第20回）：prodに先にgitops20=fast-pathを適用する | juehara-crypto | 2026-10-30 23:06:31.669501+00
(1 row)

 id | env  |                commit_sha
----+------+------------------------------------------
 75 | stg  | 4a53c5461246ed676e87330c8884d8551db98244
 74 | dev  | 4a53c5461246ed676e87330c8884d8551db98244
 73 | prod | 4a53c5461246ed676e87330c8884d8551db98244
(3 rows)
```

### ■ 結果

dev・stgは、緊急時の入力なしで、通常の順序の確認を通りました。3環境とも`4a53c54`にそろい、承認待ちは空になりました。`gitops.exceptions`はid 1の1行のままで、通常の経路では何も記録されていません。

緊急時の入力が効くのは、それを付けて起動した1回の実行だけです。入力の値はどこにも残らないため、次に起動したときは、何もしなくても通常の経路に戻ります。**[セクション2](#2-緊急対応の板挟み)** で課した「期限」の条件は、この経路では、その1回の実行として満たされています。

### ■ 検証内容：ガードレールが失敗したコミットを、緊急時の経路で適用しようとする

緊急時の経路でも、ガードレールを短縮していないことを確かめます。**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** のセクション7と同じく、`changed_when`のない`shell`のタスクを足しました。

**▼ 実行結果**（`cat -n ansible/roles/common_setup/tasks/gitops20_lint_fail.yml`）

```plaintext
     1  ---
     2  - name: 高速経路の確認用の設定ファイルに1行を追記する（changed_whenなし）
     3    become: true
     4    ansible.builtin.shell: echo "written_by=shell" >> /etc/gitops20-lint-fail.conf
```

このタスクを`main.yml`から読み込む変更をプルリクエスト（PR#119）にしました。確認の実行（「GitOps Pipeline」の実行#194）では、`ansible-lint`が失敗し、`molecule`はスキップされました。この検証環境では、チェックが失敗していてもマージできるため、そのままマージしました（マージコミット`6a7ca3f`、「GitOps Pipeline」の実行#195）。マージの実行でも`ansible-lint`は失敗しましたが、`record-pending`は成功し、3環境の承認待ちが`6a7ca3f`で作られています。

この状態で、「GitOps Apply」を、`environment`を`prod`、`emergency`を有効にし、`reason`に「障害対応の確認（第20回）：ansible-lintが失敗したコミットをprodに先に適用しようとする」と入れて起動しました（「GitOps Apply」の実行#112）。

**▼ 実行結果**（「GitOps Apply」の実行#112、`verify`ジョブのステップ「Check promotion order」「Check commits came from pull requests」「Check guardrail results」から抜粋）

```plaintext
（ステップ「Check promotion order」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
last applied (stg): 4a53c5461246ed676e87330c8884d8551db98244
exception recorded: id=2 env=prod kind=promotion-skip commit=6a7ca3f1babf28be058b50adc7eb6b5a585e027a requested_by=juehara-crypto
##[warning]promotion order skipped by emergency: 6a7ca3f1babf28be058b50adc7eb6b5a585e027a has not been applied to stg (requested_by=juehara-crypto)
（ステップ「Check commits came from pull requests」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
last applied (prod): 4a53c5461246ed676e87330c8884d8551db98244
6a7ca3f1babf28be058b50adc7eb6b5a585e027a: merge of pull request #119
（ステップ「Check guardrail results」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
ansible-lint: failure
##[error]ansible-lint on 6a7ca3f1babf28be058b50adc7eb6b5a585e027a is failure
molecule: skipped
##[error]molecule on 6a7ca3f1babf28be058b50adc7eb6b5a585e027a is skipped
##[error]Process completed with exit code 1.
```

**実行コマンド**

```plaintext
ls ~/gitops-pending
.github/scripts/exception.sh list
psql "$PG_CONN_STR" -X -c "SELECT id, env, commit_sha FROM gitops.applied WHERE env = 'prod' ORDER BY id DESC LIMIT 1;"
for n in target-node1 target-node2 target-node3; do echo "== $n"; docker exec $n sh -c 'ls -l /etc/gitops20-lint-fail.conf 2>&1'; done
```

**▼ 実行結果**

```plaintext
dev  prod  stg
 id | env  |      kind      | commit  |                                        reason                                        |  requested_by  |          created_at
----+------+----------------+---------+--------------------------------------------------------------------------------------+----------------+-------------------------------
  2 | prod | promotion-skip | 6a7ca3f | 障害対応の確認（第20回）：ansible-lintが失敗したコミットをprodに先に適用しようとする | juehara-crypto | 2026-10-30 23:27:43.671266+00
  1 | prod | promotion-skip | 4a53c54 | 障害対応の確認（第20回）：prodに先にgitops20=fast-pathを適用する                     | juehara-crypto | 2026-10-30 23:06:31.669501+00
(2 rows)

 id | env  |                commit_sha
----+------+------------------------------------------
 73 | prod | 4a53c5461246ed676e87330c8884d8551db98244
(1 row)

== target-node1
ls: cannot access '/etc/gitops20-lint-fail.conf': No such file or directory
== target-node2
ls: cannot access '/etc/gitops20-lint-fail.conf': No such file or directory
== target-node3
ls: cannot access '/etc/gitops20-lint-fail.conf': No such file or directory
```

### ■ 結果

緊急時の入力で順序の確認は飛ばせましたが、その後のガードレールの確認で、`ansible-lint: failure`、`molecule: skipped`として止まりました。prodの最後に適用したコミットは`4a53c54`のままで、target-node1〜3にファイルは作られていません。緊急時の経路でも、ガードレールを通らないコミットは、prodに届きませんでした。

止まった実行でも、`gitops.exceptions`にはid 2が残っています。順序の確認は、ガードレールの確認より前のステップのため、記録はその時点で行われます。この表は、例外で適用したものの一覧ではなく、例外を使おうとしたものの一覧です。適用まで進んだかどうかは、`run_url`の実行の結果や、`gitops.applied`と突き合わせて確かめます。

後片付けとして、`6a7ca3f`の承認待ちを、「GitOps Apply」の破棄の入力で、dev、stg、prodの順に破棄しました（「GitOps Apply」の実行#113〜#115）。続けて、足したタスクを取り除く変更をプルリクエスト（PR#120）にし、確認の実行（「GitOps Pipeline」の実行#196）で`ansible-lint`と`molecule`が成功したことを確かめて、マージしました（マージコミット`4877a84`、「GitOps Pipeline」の実行#197）。マージの実行では、`changes`以外のジョブがすべてスキップされ、承認待ちは作られませんでした。3環境の最後に適用したコミット`4a53c54`から`4877a84`までの間に、PR#119でタスクを足し、PR#120で同じタスクを取り除いたので、`ansible/`の差分が空になったためです（**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション3と同じ動き）。足したタスクはどの環境にも適用されていないため、3環境とも`4a53c54`の状態のままで、`plan`は差分なし、確認モードは5台とも`changed=0`です。

### 高速経路でも残るもの

この形で、高速経路は、昇格の順序だけを、記録を残して短縮できるようになりました。一方で、次のものは、この形でも残ります。

* **dev・stgでの本実行を経ないこと**：高速経路で適用したコミットは、prodで初めて本実行されます。Ansibleの確認モードに現れない変更（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4）は、prodで初めて起きます。記録が残るのは、その危険を引き受けて短縮したという事実です
* **追いつく前に次のマージが入った場合**：承認待ちは、マージのたびに3環境とも新しいコミットで作り直されます（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション5）。dev・stgが追いつく前に次の変更がマージされると、dev・stgは、緊急で適用したコミットを経ずに、次のコミットを受け取ります。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** のセクション7で確かめたとおり、途中のコミットに「消す」変更があれば、dev・stgでは当たらないまま残ります（この回では確かめていません）
* **記録そのものの保護**：`gitops.exceptions`は、`gitops.applied`と同じPostgreSQLにあります。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** で整理したとおり、ここに直接書き込める人は、記録を書き換えられます。`requested_by`は「GitOps Apply」を起動したGitHubのユーザーで、起動できる人を環境ごとに分けられないことも、これまでと変わりません

高速経路は、Gitを経由できる障害対応のための経路です。障害の最中には、プルリクエストを作る前に、操作対象を手で直すこともあります。次のセクションでは、Gitを経由しない手動変更のために、自動収束を一時停止する仕組みを作ります。

---

[↑ 目次に戻る](#-目次)

---

## 4. 自動収束を一時停止する

Gitを経由せずに操作対象を手で直すときのために、自動収束を環境ごとに一時停止する仕組みを作ります。

### 一時停止の状態を、どこに置くか

一時停止の状態をどこに置くかは、次の3つの条件で決めます。

|条件|満たさないと起きること|
|---|---|
|誰が、いつ、なぜ止めたかが残る|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション8と同じく、止めた理由が後から分からない|
|期限が来れば、何もしなくても一時停止が終わる|解除を忘れると、自動収束が止まったままになる|
|パイプラインから確実に参照できる|「Drift Detect」が一時停止に気づかず、手動変更を戻してしまう|

候補を、この3つの条件で比べます。

|置き場所|誰が・いつ・なぜ|期限|パイプラインからの参照|
|---|---|---|---|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** の止める印（ランナーのファイル）|残らない。中身は比べたコミットと実行のURLだけ|ない。人が消すまで残る|できる。ただし、置くにはランナーに入る必要がある|
|リポジトリに置くファイル|コミットとして残る|ファイルに書けば持てる|できる。ただし、置くにも外すにもプルリクエストとマージが要り、障害対応の最中には遅い|
|PostgreSQLの表`gitops.exceptions`（**[セクション3](#3-gitを経由する高速経路)** で作った表）|列として残る。起動したGitHubのユーザーを記録できる|列として持てる。判定のたびに今の時刻と比べられる|できる。「Drift Detect」は、すでに同じPostgreSQLから最後に適用したコミットを読んでいる|

この回では、`gitops.exceptions`に、種類`converge-pause`の行として一時停止を記録します。**[セクション3](#3-gitを経由する高速経路)** の昇格の順序を飛ばした記録と同じ表に置くことで、通常の経路を外れたものを1か所で見られます。

**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** の止める印は、そのまま残します。2つは、止める理由と止める主体が違います。

|仕組み|置くもの|止める理由|終わり方|
|---|---|---|---|
|止める印|パイプライン（収束の後の再検知で差分が残ったとき）|Playbookが収束しないため、毎回の自動収束が新しい変更になる|人が印を消す|
|一時停止|人（「Converge Pause」を起動する）|障害対応で、意図して実環境をずらしているため|人が解除するか、期限が来る|

### 止める単位

一時停止は、環境ごとに、TerraformとAnsibleの収束をまとめて止めます。

* **TerraformとAnsibleを分けない**：**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション8の障害対応では、再起動の方針（Terraformの属性）と、設定ファイルへの1行（Ansibleが管理するファイル）を、1つの対応として変えていました。片方だけを止めると、もう片方が戻され、対応が半分だけ消えます
* **ホストごとに分けない**：「Drift Detect」の収束は、環境ごとに保存したplanとPlaybookを適用します。prodの3台のうち1台だけを止めることは、今の収束の単位ではできません。prodを止めると、手を加えていない2台の収束も止まります

### ■ 検証内容：例外の記録の表に、一時停止の列を足す

`gitops.exceptions`に、期限、解除した時刻、解除した人の3つの列を足し、種類に`converge-pause`を加えます。`converge-pause`の行は、期限を必須にします。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
psql "$PG_CONN_STR" -X -v ON_ERROR_STOP=1 <<'EOF'
ALTER TABLE gitops.exceptions DROP CONSTRAINT exceptions_kind_check;
ALTER TABLE gitops.exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind IN ('promotion-skip', 'converge-pause'));
ALTER TABLE gitops.exceptions ADD COLUMN expires_at timestamptz, ADD COLUMN released_at timestamptz, ADD COLUMN released_by text;
ALTER TABLE gitops.exceptions ADD CONSTRAINT exceptions_pause_expires_check CHECK (kind <> 'converge-pause' OR expires_at IS NOT NULL);
EOF
echo "alter_exit_code=$?"
psql "$PG_CONN_STR" -X -c '\d gitops.exceptions'
```

**▼ 実行結果**

```plaintext
ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
alter_exit_code=0
                                           Table "gitops.exceptions"
    Column    |           Type           | Collation | Nullable |                    Default
--------------+--------------------------+-----------+----------+-----------------------------------------------
 id           | bigint                   |           | not null | nextval('gitops.exceptions_id_seq'::regclass)
 env          | text                     |           | not null |
 kind         | text                     |           | not null |
 commit_sha   | text                     |           | not null |
 reason       | text                     |           | not null |
 requested_by | text                     |           | not null |
 run_url      | text                     |           | not null |
 created_at   | timestamp with time zone |           | not null | now()
 expires_at   | timestamp with time zone |           |          |
 released_at  | timestamp with time zone |           |          |
 released_by  | text                     |           |          |
Indexes:
    "exceptions_pkey" PRIMARY KEY, btree (id)
Check constraints:
    "exceptions_env_check" CHECK (env = ANY (ARRAY['dev'::text, 'stg'::text, 'prod'::text]))
    "exceptions_kind_check" CHECK (kind = ANY (ARRAY['promotion-skip'::text, 'converge-pause'::text]))
    "exceptions_pause_expires_check" CHECK (kind <> 'converge-pause'::text OR expires_at IS NOT NULL)
    "exceptions_reason_check" CHECK (length(btrim(reason)) > 0)
```

この回では、一時停止が有効かどうかを、次のように判定します。

* 種類が`converge-pause`で、`released_at`が空で、`expires_at`が今より後の行があれば、その環境は一時停止中
* 期限を過ぎた行は、`released_at`が空のままでも一時停止として扱わない。期限が来たときに何かを書き換える処理はなく、判定のたびに今の時刻と比べる

### ■ 検証内容：一時停止のワークフローと、「Drift Detect」の確認を加える

記録のスクリプト`.github/scripts/exception.sh`に、一時停止を記録する`pause`、解除する`release`、有効な一時停止を表示する`active`の3つの操作を足しました。

**▼ 実行結果**（`cat -n .github/scripts/exception.sh`から、足した操作の部分を抜粋）

```plaintext
    33    pause)
    34      [ $# -eq 7 ] || usage
    35      check_env "$2"
    36      case "$7" in
    37        ''|*[!0-9]*) usage ;;
    38      esac
    39      { [ "$7" -ge 1 ] && [ "$7" -le 1440 ]; } || usage
    40      row=$(printf '%s\n' "INSERT INTO gitops.exceptions (env, kind, commit_sha, reason, requested_by, run_url, expires_at) VALUES (:'env', 'converge-pause', :'sha', :'reason', :'by', :'url', now() + make_interval(mins => :min)) RETURNING id, to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');" \
    41        | psql "$PG_CONN_STR" -X -q -A -t -F ' ' -v ON_ERROR_STOP=1 -v env="$2" -v sha="$3" -v reason="$4" -v by="$5" -v url="$6" -v min="$7")
    42      echo "pause recorded: id=${row%% *} env=$2 commit=$3 requested_by=$5 expires_at=${row#* } UTC"
    43      ;;
    44    release)
    45      [ $# -eq 3 ] || usage
    46      check_env "$2"
    47      ids=$(printf '%s\n' "UPDATE gitops.exceptions SET released_at = now(), released_by = :'by' WHERE env = :'env' AND kind = 'converge-pause' AND released_at IS NULL AND expires_at > now() RETURNING id;" \
    48        | psql "$PG_CONN_STR" -X -q -A -t -v ON_ERROR_STOP=1 -v env="$2" -v by="$3")
    49      if [ -z "$ids" ]; then
    50        echo "no active pause for $2"
    51        exit 1
    52      fi
    53      echo "pause released: env=$2 id=$(printf '%s' "$ids" | tr '\n' ',') released_by=$3"
    54      ;;
    55    active)
    56      [ $# -eq 2 ] || usage
    57      check_env "$2"
    58      line=$(printf '%s\n' "SELECT 'id=' || id || ' expires_at=' || to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC requested_by=' || requested_by || ' reason=' || reason FROM gitops.exceptions WHERE env = :'env' AND kind = 'converge-pause' AND released_at IS NULL AND expires_at > now() ORDER BY expires_at DESC LIMIT 1;" \
    59        | psql "$PG_CONN_STR" -X -q -A -t -v ON_ERROR_STOP=1 -v env="$2")
    60      [ -n "$line" ] || exit 1
    61      echo "$line"
    62      ;;
```

`active`は、有効な一時停止があれば1行を表示して終了コード0、なければ何も表示せずに終了コード1を返します。期限は1〜1440分（24時間）の範囲だけを受け付けます。

一時停止と解除は、新しいGitHub Actionsのワークフロー「Converge Pause」（`.github/workflows/converge-pause.yml`、self-hostedランナー、手動の起動だけ）で行います。

**▼ 実行結果**（`cat -n .github/workflows/converge-pause.yml`）

```plaintext
     1  name: Converge Pause
     2
     3  on:
     4    workflow_dispatch:
     5      inputs:
     6        environment:
     7          description: '自動収束を一時停止する環境'
     8          type: choice
     9          options:
    10            - dev
    11            - stg
    12            - prod
    13          default: dev
    14        action:
    15          description: 'pause：一時停止する、release：一時停止を解除する'
    16          type: choice
    17          options:
    18            - pause
    19            - release
    20          default: pause
    21        reason:
    22          description: '一時停止する理由（pauseのときに必須）'
    23          type: string
    24          default: ''
    25        minutes:
    26          description: '一時停止の期限（分、1〜1440。pauseのときに使う）'
    27          type: string
    28          default: '240'
    29
    30  concurrency:
    31    group: gitops-pipeline
    32    queue: max
    33
    34  permissions:
    35    contents: read
    36
    37  env:
    38    TARGET_ENV: ${{ inputs.environment }}
    39
    40  jobs:
    41    pause:
    42      runs-on: [self-hosted, Linux, X64]
    43      steps:
    44        - name: Check branch
    45          run: |
    46            echo "ref=$GITHUB_REF sha=$GITHUB_SHA environment=$TARGET_ENV"
    47            if [ "$GITHUB_REF" != "refs/heads/main" ]; then
    48              echo "::error::not started from main"
    49              exit 1
    50            fi
    51        - uses: actions/checkout@v4
    52        - name: Pause or release converge
    53          env:
    54            PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
    55            ACTION: ${{ inputs.action }}
    56            REASON: ${{ inputs.reason }}
    57            MINUTES: ${{ inputs.minutes }}
    58          run: |
    59            if [ "$ACTION" = "release" ]; then
    60              .github/scripts/exception.sh release "$TARGET_ENV" "$GITHUB_ACTOR"
    61            else
    62              if [ -z "$(printf '%s' "$REASON" | tr -d '[:space:]')" ]; then
    63                echo "::error::pause requires a reason"
    64                exit 1
    65              fi
    66              sha=$(.github/scripts/applied.sh last "$TARGET_ENV")
    67              .github/scripts/exception.sh pause "$TARGET_ENV" "$sha" "$REASON" "$GITHUB_ACTOR" "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" "$MINUTES"
    68            fi
    69            .github/scripts/exception.sh active "$TARGET_ENV" || echo "no active pause for $TARGET_ENV"
```

作りは、次のとおりです。

* 一時停止には理由を必須にする。**[セクション3](#3-gitを経由する高速経路)** の緊急時の入力と同じく、理由は環境変数で渡す
* 記録するコミットは、その環境の最後に適用したコミット。どの状態からずれることを許したのかを残す
* 起動した人は、GitHub Actionsが渡すユーザー名（`GITHUB_ACTOR`）で記録する。一時停止のためにランナーに入る必要はない
* 同時実行のグループは、「GitOps Pipeline」「GitOps Apply」「Drift Detect」と同じ`gitops-pipeline`にする。収束の途中で一時停止が書き換わらないようにするため

「Drift Detect」には、収束のループの、止める印の確認の直後に、一時停止の確認を足しました。

**▼ 実行結果**（`git diff .github/workflows/drift-detect.yml`）

```plaintext
@@ -123,6 +123,19 @@ jobs:
               } >> "$RUNNER_TEMP/report-$e.md"
               continue
             fi
+            pause_rc=0
+            pause=$(.github/scripts/exception.sh active "$e") || pause_rc=$?
+            if [ "$pause_rc" -ne 1 ]; then
+              if [ "$pause_rc" -ne 0 ]; then
+                pause="一時停止を確かめられなかった（exit_code=$pause_rc）"
+              fi
+              echo "HOLD $e converge-pause: $pause"
+              {
+                echo
+                echo "- 自動収束: 一時停止中のため戻していない（$pause）"
+              } >> "$RUNNER_TEMP/report-$e.md"
+              continue
+            fi
             wt="$RUNNER_TEMP/detect-$e"
             ref=$(git -C "$wt" rev-parse HEAD)
             tf_rc=-1; ans_rc=-1
```

* 一時停止中なら、`HOLD <環境> converge-pause: …`を出し、その環境のIssueの本文に、一時停止のid、期限、起動した人、理由を書き足して、収束を飛ばす
* 検知とIssueへの記録は、これまでどおり続ける。一時停止が止めるのは、収束だけ
* 一時停止を確かめられなかったとき（PostgreSQLに接続できないなど）も、収束を飛ばす。記録が読めないときに戻してしまうと、一時停止で守るはずだった手動変更を消すおそれがあるため、止める側に倒す

この変更をプルリクエスト（PR#121）にし、確認の実行（「GitOps Pipeline」の実行#198）とマージの実行（「GitOps Pipeline」の実行#199）で`changes`ジョブだけが動いたことを確かめて、マージしました（マージコミット`d57819e`）。

### ■ 検証内容：prodの自動収束を一時停止する

「Converge Pause」を、`environment`を`prod`、`action`を`pause`、`reason`を「障害対応の確認（第20回）：prodの手動変更を自動収束から守る」、`minutes`を既定の`240`にして起動しました（「Converge Pause」の実行#1）。

**▼ 実行結果**（「Converge Pause」の実行#1、`pause`ジョブのステップ「Pause or release converge」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  TARGET_ENV: prod
  PG_CONN_STR: ***
  ACTION: pause
  REASON: 障害対応の確認（第20回）：prodの手動変更を自動収束から守る
  MINUTES: 240
pause recorded: id=3 env=prod commit=4a53c5461246ed676e87330c8884d8551db98244 requested_by=juehara-crypto expires_at=2026-10-31 08:41:42 UTC
id=3 expires_at=2026-10-31 08:41:42 UTC requested_by=juehara-crypto reason=障害対応の確認（第20回）：prodの手動変更を自動収束から守る
```

**実行コマンド**

```plaintext
.github/scripts/exception.sh list
.github/scripts/exception.sh active prod; echo "exit_code=$?"
.github/scripts/exception.sh active dev; echo "exit_code=$?"
.github/scripts/exception.sh active stg; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
 id | env  |      kind      | commit  |                                        reason                                        |  requested_by  |          created_at           |          expires_at           | released_at | released_by
----+------+----------------+---------+--------------------------------------------------------------------------------------+----------------+-------------------------------+-------------------------------+-------------+-------------
  3 | prod | converge-pause | 4a53c54 | 障害対応の確認（第20回）：prodの手動変更を自動収束から守る                           | juehara-crypto | 2026-10-31 04:41:42.574326+00 | 2026-10-31 08:41:42.574326+00 |             |
  2 | prod | promotion-skip | 6a7ca3f | 障害対応の確認（第20回）：ansible-lintが失敗したコミットをprodに先に適用しようとする | juehara-crypto | 2026-10-30 23:27:43.671266+00 |                               |             |
  1 | prod | promotion-skip | 4a53c54 | 障害対応の確認（第20回）：prodに先にgitops20=fast-pathを適用する                     | juehara-crypto | 2026-10-30 23:06:31.669501+00 |                               |             |
(3 rows)

id=3 expires_at=2026-10-31 08:41:42 UTC requested_by=juehara-crypto reason=障害対応の確認（第20回）：prodの手動変更を自動収束から守る
exit_code=0
exit_code=1
exit_code=1
```

prodには4時間後を期限とする一時停止があり、devとstgにはありません。

### ■ 検証内容：prodとdevに同じ手動変更を加え、収束を有効にして検知する

**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション8と同じ2つの手動変更を、一時停止しているprodのtarget-node1と、一時停止していないdevのdev-node1の両方に加えました。

**実行コマンド**

```plaintext
for n in target-node1 dev-node1; do
  echo "== $n"
  docker update --restart=always $n
  docker exec $n sh -c 'echo "# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと" >> /etc/drift-check-target.conf'
  docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' $n
  docker exec $n cat /etc/drift-check-target.conf
done
```

**▼ 実行結果**

```plaintext
== target-node1
target-node1
/target-node1 restart=always
monitored_by=ansible-drift-check
# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと
== dev-node1
dev-node1
/dev-node1 restart=always
monitored_by=ansible-drift-check
# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと
```

「Drift Detect」は、スケジュール実行では収束を行いません。**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション8と同じく、定期実行で収束を有効にしていた場合を想定して、`compare_with`を`last-applied`、`converge`を有効にして手動で起動しました（「Drift Detect」の実行#42）。

**▼ 実行結果**（「Drift Detect」の実行#42、`detect`ジョブから抜粋）

```plaintext
  COMPARE_WITH: last-applied
  CONVERGE: true
（途中省略：環境変数の表示）
== dev
compare_with=last-applied ref=4a53c5461246ed676e87330c8884d8551db98244
（途中省略：Refreshing state）
  # module.lab_env.docker_container.targets["dev-node1"] will be updated in-place
  ~ resource "docker_container" "targets" {
        id                                          = "c19b56ffe13230439585b6cb292c6fae7dcab9331d8c49b8757a718ec304bc18"
        name                                        = "dev-node1"
      ~ restart                                     = "always" -> "no"
        # (48 unchanged attributes hidden)
（途中省略）
changed: dev-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
RESULT dev=drift plan_exit_code=2 check_exit_code=0 changed=1 failed_hosts=0
== stg
compare_with=last-applied ref=4a53c5461246ed676e87330c8884d8551db98244
（途中省略：planは差分なし）
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== prod
compare_with=last-applied ref=4a53c5461246ed676e87330c8884d8551db98244
（途中省略：Refreshing state）
  # module.lab_env.docker_container.targets["target-node1"] will be updated in-place
  ~ resource "docker_container" "targets" {
        id                                          = "ade38668fb28bd7dc2cea7e840fa4daa000599245f26deaf5c532c8868c45d10"
        name                                        = "target-node1"
      ~ restart                                     = "always" -> "no"
        # (48 unchanged attributes hidden)
（途中省略）
changed: target-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
RESULT prod=drift plan_exit_code=2 check_exit_code=0 changed=1 failed_hosts=0
== converge dev
guardrail dev terraform-static: skipped
guardrail dev ansible-lint: success
guardrail dev molecule: success
（途中省略：保存したplanのハッシュ値と、planの判定）
policy: pass
module.lab_env.docker_container.targets["dev-node1"]: Modifying... [id=c19b56ffe13230439585b6cb292c6fae7dcab9331d8c49b8757a718ec304bc18]
module.lab_env.docker_container.targets["dev-node1"]: Modifications complete after 0s [id=c19b56ffe13230439585b6cb292c6fae7dcab9331d8c49b8757a718ec304bc18]

Apply complete! Resources: 0 added, 1 changed, 0 destroyed.
（途中省略：Outputs、PLAYの表示）
TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
（途中省略：Pythonの警告）
--- before: /etc/drift-check-target.conf
+++ after: /etc/drift-check-target.conf
@@ -1,2 +1 @@
 monitored_by=ansible-drift-check
-# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと

changed: [dev-node1]
（途中省略：ほかのタスクはok）
dev-node1                  : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
CONVERGE dev ref=4a53c5461246ed676e87330c8884d8551db98244 terraform_apply_exit_code=0 ansible_exit_code=0
RECHECK dev=converged plan_exit_code=0 check_exit_code=0 changed=0
== converge prod
HOLD prod converge-pause: id=3 expires_at=2026-10-31 08:41:42 UTC requested_by=juehara-crypto reason=障害対応の確認（第20回）：prodの手動変更を自動収束から守る
（ステップ「Report to issues」）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
issue #122 created: [drift-detect] prod
```

**実行コマンド**

```plaintext
for n in target-node1 dev-node1; do
  echo "== $n"
  docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' $n
  docker exec $n cat /etc/drift-check-target.conf
done
```

**▼ 実行結果**

```plaintext
== target-node1
/target-node1 restart=always
monitored_by=ansible-drift-check
# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと
== dev-node1
/dev-node1 restart=no
monitored_by=ansible-drift-check
```

prodのIssue（Issue#122）の本文は、次のとおりです。

**▼ 実行結果**（Issue#122の本文）

```plaintext
- 結果: drift
- 比べたコミット: 4a53c5461246ed676e87330c8884d8551db98244
- plan_exit_code=2 check_exit_code=0 changed=1 failed_hosts=0
- 実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/41169801725
- 時刻: 2026-10-31T04:45:45Z

- changed: target-node1 common_setup : ドリフト検知の実演用設定ファイルを配置

- 自動収束: 一時停止中のため戻していない（id=3 expires_at=2026-10-31 08:41:42 UTC requested_by=juehara-crypto reason=障害対応の確認（第20回）：prodの手動変更を自動収束から守る）
```

### ■ 結果

同じ手動変更に対する、3つの環境の扱いを並べます。

|項目|dev（一時停止なし）|stg（手動変更なし）|prod（一時停止中）|
|---|---|---|---|
|検知|`drift`（`restart`と1行）|`no_drift`|`drift`（`restart`と1行）|
|収束|ガードレール、planの判定を通り、保存したplanとAnsibleで戻した|対象外|`HOLD prod converge-pause`で飛ばした|
|再検知|`converged`|対象外|行っていない|
|実環境|`restart=no`、1行は消えた|変化なし|`restart=always`、1行は残った|
|Issue|作られていない（`no open issue`）|作られていない|Issue#122を作り、一時停止中であることと、その理由を残した|

一時停止したprodでは、手動変更は戻されませんでした。一方で、検知は止まっておらず、差分があること、それが一時停止のために戻されていないこと、誰が、なぜ、いつまで止めたのかが、prodのIssueに残りました。

一時停止していないdevでは、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション8と同じく、「戻さないこと」と書いた1行も含めて、2つの手動変更が1回の実行で戻され、Issueも作られませんでした。一時停止がなければ、手動変更の意図は、これまでと同じく何も残りません。

### ■ 検証内容：手動変更を戻し、一時停止を解除する

手動変更をGitに取り込む流れと、取り込まなかった変更のうちPlaybookが管理しているものが自動収束で戻ることは、**[セクション6](#6-手動変更をgitに戻す)** で扱います。ここでは、障害対応が終わり、手で戻した場合として、target-node1の手動変更を手で元に戻し、一時停止を解除しました。

**実行コマンド**

```plaintext
docker update --restart=no target-node1
docker exec target-node1 sed -i '/^# 障害対応中/d' /etc/drift-check-target.conf
docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' target-node1
docker exec target-node1 cat /etc/drift-check-target.conf
```

**▼ 実行結果**

```plaintext
target-node1
/target-node1 restart=no
monitored_by=ansible-drift-check
```

「Converge Pause」を、`environment`を`prod`、`action`を`release`にして起動しました（「Converge Pause」の実行#2）。

**▼ 実行結果**（「Converge Pause」の実行#2、`pause`ジョブのステップ「Pause or release converge」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  TARGET_ENV: prod
  PG_CONN_STR: ***
  ACTION: release
  REASON: 
  MINUTES: 240
pause released: env=prod id=3 released_by=juehara-crypto
no active pause for prod
```

**実行コマンド**

```plaintext
.github/scripts/exception.sh list 1
.github/scripts/exception.sh active prod; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
 id | env  |      kind      | commit  |                           reason                           |  requested_by  |          created_at           |          expires_at           |          released_at          |  released_by
----+------+----------------+---------+------------------------------------------------------------+----------------+-------------------------------+-------------------------------+-------------------------------+----------------
  3 | prod | converge-pause | 4a53c54 | 障害対応の確認（第20回）：prodの手動変更を自動収束から守る | juehara-crypto | 2026-10-31 04:41:42.574326+00 | 2026-10-31 08:41:42.574326+00 | 2026-10-31 04:52:48.380762+00 | juehara-crypto
(1 row)

exit_code=1
```

続けて、`converge`を無効にして「Drift Detect」を起動しました（「Drift Detect」の実行#43）。

**▼ 実行結果**（「Drift Detect」の実行#43、`detect`ジョブから抜粋）

```plaintext
  COMPARE_WITH: last-applied
  CONVERGE: false
（途中省略：3環境とも、planは差分なし、確認モードはchanged=0）
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（ステップ「Report to issues」）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
issue #122 closed: [drift-detect] prod
```

### ■ 結果

一時停止のid 3には、期限（08:41:42 UTC）より前の04:52:48 UTCに、誰が解除したのかが記録されました。期限を待たずに人が解除したことが、記録から分かります。手動変更を戻した後の検知では3環境とも差分がなく、一時停止中に開いたIssue#122も閉じられました。

### 一時停止が止めないもの

この一時停止が止めるのは、「Drift Detect」の自動収束だけです。次のものは止めません。

* **「GitOps Apply」による適用**：一時停止中のprodに、ほかの変更を「GitOps Apply」で適用すると、Ansibleの本実行はPlaybookの全体に対して行われます（**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション3）。Playbookが管理しているものは、一時停止に関係なく戻ります（仕組みからの導出で、この回では確かめていません）。一時停止は、通常の変更の適用まで止める仕組みではありません
* **期限が来たときの動き**：期限は、「Drift Detect」が判定するたびに今の時刻と比べるだけです。期限が来た瞬間に何かが動くわけではありません。期限が過ぎた後の最初の実行で、自動収束が再開します

一時停止は、止めている間、通常の経路を外れた状態を意図して作るものです。次のセクションでは、この一時停止そのものが新しいドリフトの原因になることを扱います。

---

[↑ 目次に戻る](#-目次)

---

## 5. 一時停止そのものがドリフトの原因になる

**[セクション4](#4-自動収束を一時停止する)** の一時停止は、手動変更を守る一方で、それ自体が新しいドリフトの原因になります。このセクションでは、その手当てを確かめます。

### 解除し忘れた一時停止は、自動収束を止め続ける

一時停止を解除し忘れると、その環境の自動収束は止まったままになります。止まっている間に起きたドリフトは、障害対応とは関係のない変更であっても戻されません。担当者が障害対応を終えて別の作業に移った後も、パイプラインは「戻さない」と判断し続けます。

これは、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** で扱った「検知が止まったことに気づけない」と同じ形の問題です。第18回では、検知そのものが止まると、ドリフトがあっても何も報告されず、「報告がない」ことが「ドリフトがない」ことに見えてしまうため、検知が止まったことに気づく確認役のワークフロー「Drift Detect Watch」を置きました。一時停止の解除し忘れでは、止まっているのは収束で、「戻されていない」ことが、ドリフトがないことと見分けにくくなります。

この回では、次の3つで手当てします。

|手当て|作ったところ|満たすこと|
|---|---|---|
|検知は止めない|**[セクション4](#4-自動収束を一時停止する)** の「Drift Detect」の確認。一時停止中も検知を続け、Issueに「一時停止中のため戻していない」と、一時停止のid、期限、起動した人、理由を書き足す|一時停止中に差分があることが、Issueに残り続ける|
|期限を必須にする|**[セクション4](#4-自動収束を一時停止する)** の表の制約（`converge-pause`は`expires_at`が必須）と、`exception.sh pause`の範囲（1〜1440分）|期限のない一時停止は作れない。長くても24時間で終わる|
|期限切れの判定に、解除の操作を要らないようにする|`exception.sh active`の条件（`expires_at`が今より後）|期限が過ぎれば、誰も何もしなくても、次の判定から一時停止として扱われない|

### ■ 検証内容：期限10分で一時停止し、期限内に検知する

「Converge Pause」を、`environment`を`prod`、`action`を`pause`、`reason`を「障害対応の確認（第20回）：期限で一時停止が終わることを確かめる」、`minutes`を`10`にして起動しました（「Converge Pause」の実行#3）。

**▼ 実行結果**（「Converge Pause」の実行#3、`pause`ジョブのステップ「Pause or release converge」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
  TARGET_ENV: prod
  PG_CONN_STR: ***
  ACTION: pause
  REASON: 障害対応の確認（第20回）：期限で一時停止が終わることを確かめる
  MINUTES: 10
pause recorded: id=4 env=prod commit=4a53c5461246ed676e87330c8884d8551db98244 requested_by=juehara-crypto expires_at=2026-10-31 05:13:18 UTC
id=4 expires_at=2026-10-31 05:13:18 UTC requested_by=juehara-crypto reason=障害対応の確認（第20回）：期限で一時停止が終わることを確かめる
```

続けて、**[セクション4](#4-自動収束を一時停止する)** と同じ2つの手動変更を、target-node1に加えました。

**実行コマンド**

```plaintext
docker update --restart=always target-node1
docker exec target-node1 sh -c 'echo "# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと" >> /etc/drift-check-target.conf'
docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' target-node1
docker exec target-node1 cat /etc/drift-check-target.conf
date -u '+now=%Y-%m-%d %H:%M:%S UTC'
```

**▼ 実行結果**

```plaintext
target-node1
/target-node1 restart=always
monitored_by=ansible-drift-check
# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと
now=2026-10-31 05:05:41 UTC
```

期限内に、`compare_with`を`last-applied`、`converge`を有効にして「Drift Detect」を起動しました（「Drift Detect」の実行#44）。

**▼ 実行結果**（「Drift Detect」の実行#44、`detect`ジョブから抜粋）

```plaintext
  COMPARE_WITH: last-applied
  CONVERGE: true
（途中省略：環境変数の表示）
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（途中省略）
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== prod
compare_with=last-applied ref=4a53c5461246ed676e87330c8884d8551db98244
（途中省略：Refreshing state）
      ~ restart                                     = "always" -> "no"
（途中省略）
changed: target-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
RESULT prod=drift plan_exit_code=2 check_exit_code=0 changed=1 failed_hosts=0
== converge prod
HOLD prod converge-pause: id=4 expires_at=2026-10-31 05:13:18 UTC requested_by=juehara-crypto reason=障害対応の確認（第20回）：期限で一時停止が終わることを確かめる
（ステップ「Report to issues」）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
issue #123 created: [drift-detect] prod
```

05:07:23 UTCの判定では、id 4は期限内で、収束を飛ばしました。prodのIssue（Issue#123）が作られ、手動変更はtarget-node1に残りました。

### ■ 検証内容：期限が過ぎるのを待つ

画面の表示ではなく、`exception.sh active prod`が終了コード1を返すまで、制御ノードで30秒ごとに確かめました。解除の操作は行っていません。

**実行コマンド**

```plaintext
until ! .github/scripts/exception.sh active prod > /dev/null; do date -u '+waiting %H:%M:%S UTC'; sleep 30; done
date -u '+expired_check=%Y-%m-%d %H:%M:%S UTC'
.github/scripts/exception.sh active prod; echo "exit_code=$?"
.github/scripts/exception.sh list 1
docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' target-node1
docker exec target-node1 cat /etc/drift-check-target.conf
```

**▼ 実行結果**

```plaintext
waiting 05:09:15 UTC
（途中省略：30秒ごとのwaitingの行）
waiting 05:13:16 UTC
expired_check=2026-10-31 05:13:46 UTC
exit_code=1
 id | env  |      kind      | commit  |                             reason                             |  requested_by  |          created_at          |          expires_at          | released_at | released_by
----+------+----------------+---------+----------------------------------------------------------------+----------------+------------------------------+------------------------------+-------------+-------------
  4 | prod | converge-pause | 4a53c54 | 障害対応の確認（第20回）：期限で一時停止が終わることを確かめる | juehara-crypto | 2026-10-31 05:03:18.80257+00 | 2026-10-31 05:13:18.80257+00 |             |
(1 row)

/target-node1 restart=always
monitored_by=ansible-drift-check
# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと
```

期限の05:13:18 UTCを過ぎた最初の確認で、有効な一時停止はなくなりました。id 4の`released_at`と`released_by`は空のままです。一方で、期限が来ただけでは、target-node1の手動変更は何も変わっていません。

### ■ 検証内容：期限切れの後に、収束を有効にして検知する

`converge`を有効にして、もう一度「Drift Detect」を起動しました（「Drift Detect」の実行#45）。

**▼ 実行結果**（「Drift Detect」の実行#45、`detect`ジョブから抜粋）

```plaintext
  COMPARE_WITH: last-applied
  CONVERGE: true
（途中省略：dev、stgはno_drift）
== prod
compare_with=last-applied ref=4a53c5461246ed676e87330c8884d8551db98244
（途中省略：Refreshing state）
      ~ restart                                     = "always" -> "no"
（途中省略）
changed: target-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
RESULT prod=drift plan_exit_code=2 check_exit_code=0 changed=1 failed_hosts=0
== converge prod
guardrail prod terraform-static: skipped
guardrail prod ansible-lint: success
guardrail prod molecule: success
0dd492d623616f57f98e94e04ee3af23e720bb47566544c1b1ffe6360dd324e1  /home/control/actions-runner/_work/_temp/tfplan-prod
PASS  module.lab_env.docker_container.targets["target-node1"] actions=update
policy: pass
module.lab_env.docker_container.targets["target-node1"]: Modifying... [id=ade38668fb28bd7dc2cea7e840fa4daa000599245f26deaf5c532c8868c45d10]
module.lab_env.docker_container.targets["target-node1"]: Modifications complete after 1s [id=ade38668fb28bd7dc2cea7e840fa4daa000599245f26deaf5c532c8868c45d10]

Apply complete! Resources: 0 added, 1 changed, 0 destroyed.
（途中省略：Outputs、PLAYの表示、Pythonの警告）
--- before: /etc/drift-check-target.conf
+++ after: /etc/drift-check-target.conf
@@ -1,2 +1 @@
 monitored_by=ansible-drift-check
-# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと

changed: [target-node1]
（途中省略：ほかのタスクはok）
target-node1               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
CONVERGE prod ref=4a53c5461246ed676e87330c8884d8551db98244 terraform_apply_exit_code=0 ansible_exit_code=0
RECHECK prod=converged plan_exit_code=0 check_exit_code=0 changed=0
（ステップ「Report to issues」）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
issue #123 closed: [drift-detect] prod
```

**実行コマンド**

```plaintext
docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' target-node1
docker exec target-node1 cat /etc/drift-check-target.conf
.github/scripts/exception.sh list 1
ls -la ~/gitops-converge-hold
```

**▼ 実行結果**

```plaintext
/target-node1 restart=no
monitored_by=ansible-drift-check
 id | env  |      kind      | commit  |                             reason                             |  requested_by  |          created_at          |          expires_at          | released_at | released_by
----+------+----------------+---------+----------------------------------------------------------------+----------------+------------------------------+------------------------------+-------------+-------------
  4 | prod | converge-pause | 4a53c54 | 障害対応の確認（第20回）：期限で一時停止が終わることを確かめる | juehara-crypto | 2026-10-31 05:03:18.80257+00 | 2026-10-31 05:13:18.80257+00 |             |
(1 row)

ls: cannot access '/home/control/gitops-converge-hold': No such file or directory
```

### ■ 結果

期限の前後で、同じ手動変更に対する扱いを並べます。

|項目|期限内（「Drift Detect」の実行#44）|期限切れの後（「Drift Detect」の実行#45）|
|---|---|---|
|`exception.sh active prod`|id 4（終了コード0）|なし（終了コード1）|
|検知|`drift`|`drift`|
|収束|`HOLD prod converge-pause`で飛ばした|ガードレール、planの判定を通り、保存したplanとAnsibleで戻した|
|再検知|行っていない|`converged`|
|Issue|Issue#123を作った|Issue#123を閉じた|
|target-node1|`restart=always`、1行は残った|`restart=no`、1行は消えた|

解除の操作をしなくても、期限が過ぎた後の最初の収束で、一時停止で守っていた手動変更は戻りました。止める印も置かれていません。一時停止は、期限を過ぎた時点で、何も残さずに通常の自動収束へ戻ります。

記録には、終わり方の違いが残ります。**[セクション4](#4-自動収束を一時停止する)** のid 3は、期限より前に`released_at`と`released_by`が埋まり、人が解除したことが分かります。このセクションのid 4は、`released_at`が空のまま`expires_at`を過ぎていて、期限で終わったことが分かります。

### 期限が来ても、すぐには戻らない

期限は、「Drift Detect」が判定するたびに今の時刻と比べるだけです。上の検証でも、期限の05:13:18 UTCを過ぎてから、手動変更は残ったままで、次に収束を有効にして起動した05:15台に戻りました。期限切れから実際に戻るまでの時間は、収束が次にいつ動くかで決まります。

**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** の「Drift Detect」は、スケジュール実行では収束を行いません。スケジュール実行で収束を有効にするかどうかで、期限切れの後の動きは次のように変わります。

|スケジュール実行の収束|期限切れの後に起きること|引き受けること|
|---|---|---|
|有効にする|期限切れの後の最初のスケジュール実行で戻る|人が見ていない時刻に、手動変更が戻る。**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** で確かめたとおり、スケジュール実行は遅れたり動かなかったりするため、戻る時刻はスケジュールどおりにならない|
|無効のまま|人が収束を有効にして「Drift Detect」を起動するまで戻らない。スケジュール実行は検知を続け、Issueに差分を残し続ける|期限切れの後は、一時停止の行もなく、ただの差分ありとしてIssueに残る。戻すかどうかは、Issueを見た人の判断になる|

どちらを選んでも、一時停止中に検知が止まらないこと、期限で一時停止が終わること、その経緯が`gitops.exceptions`とIssueに残ることは変わりません。この回の検証環境では、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** と同じく、スケジュール実行の収束は無効のままにしています。

### 期限で縛れないもの

期限は、1回の一時停止の長さを縛るだけです。次のものは、この形では縛れません。

* **一時停止の繰り返し**：期限が切れる前に、もう一度「Converge Pause」で一時停止すれば、止めている期間は延びます。延長のたびに新しい行が残るため、何度延長したかは記録から分かりますが、延長の回数や合計の長さを止める仕組みはありません（仕組みからの導出で、この回では確かめていません）
* **手動変更そのものの扱い**：期限が来て自動収束で戻るのは、その手動変更が不要になった場合には正しい動きです。障害対応のために、手動変更をそのまま残す必要がある場合は、期限内に、変更をGitに取り込む必要があります

次のセクションでは、手で加えた変更をGitに戻す流れと、戻さなかった変更のうちPlaybookが管理しているものが自動収束で元に戻ることを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 6. 手動変更をGitに戻す

一時停止で守っている間に、手で加えた変更を「Gitに戻す」のか「捨てる」のかを決めます。このセクションでは、Gitに戻さなかった場合と、戻した場合を、それぞれ確かめます。

### 戻すか、捨てるか

一時停止は、手動変更を期限まで守るだけで、その変更をどうするかは決めません。期限までに、次のどちらかを選ぶ必要があります。

|選択|やること|一時停止を外した後に起きること|
|---|---|---|
|捨てる|Gitには何もしない|Playbookやコードが管理しているものは、自動収束で元に戻る|
|Gitに戻す（バックポート）|手動変更と同じ内容をコードに書き、プルリクエストとして通常の経路で適用する|最後に適用したコミットが手動変更を含むようになり、検知は差分なしになる|

どちらを選んでも、「最後に適用したコミット」と実環境が一致する状態に戻ります。違いは、手動変更が実環境から消えるか、Gitの記述として残るかです。

### ■ 検証内容：Gitに戻さない場合

「Converge Pause」を、`environment`を`prod`、`action`を`pause`、`reason`を「障害対応の確認（第20回）：Gitに戻さない手動変更の扱いを確かめる」にして起動しました（「Converge Pause」の実行#4、一時停止のid 5）。そのうえで、target-node1に、Playbookが管理しているものと、管理していないものの2つを手で加えました。

|手動変更|Playbookやコードでの扱い|
|---|---|
|`/etc/drift-check-target.conf`への1行|Ansibleが`copy`で中身を管理している|
|新しいファイル`/etc/gitops20-manual.conf`|どのタスクにもリソースにもない|

**実行コマンド**

```plaintext
docker exec target-node1 sh -c 'echo "# 障害対応中（2026-10-31）: 一時的な設定。Gitには戻さない" >> /etc/drift-check-target.conf'
docker exec target-node1 sh -c 'echo "emergency_workaround=enabled" > /etc/gitops20-manual.conf'
docker exec target-node1 cat /etc/drift-check-target.conf
docker exec target-node1 cat /etc/gitops20-manual.conf
```

**▼ 実行結果**

```plaintext
monitored_by=ansible-drift-check
# 障害対応中（2026-10-31）: 一時的な設定。Gitには戻さない
emergency_workaround=enabled
```

障害対応が終わり、この手動変更はGitに戻さないと決めた場合として、「Converge Pause」で一時停止を解除しました（「Converge Pause」の実行#5、id 5は05:27:19 UTCに解除）。続けて、`compare_with`を`last-applied`、`converge`を有効にして「Drift Detect」を起動しました（「Drift Detect」の実行#46）。

**▼ 実行結果**（「Drift Detect」の実行#46、`detect`ジョブから抜粋）

```plaintext
  COMPARE_WITH: last-applied
  CONVERGE: true
（途中省略：dev、stgはno_drift）
== prod
compare_with=last-applied ref=4a53c5461246ed676e87330c8884d8551db98244
（途中省略：Refreshing state）
No changes. Your infrastructure matches the configuration.
（途中省略）
{"target-node1":{"changed":1,（途中省略）},"target-node2":{"changed":0,（途中省略）},"target-node3":{"changed":0,（途中省略）}}
changed: target-node1 common_setup : ドリフト検知の実演用設定ファイルを配置
RESULT prod=drift plan_exit_code=0 check_exit_code=0 changed=1 failed_hosts=0
== converge prod
guardrail prod terraform-static: skipped
guardrail prod ansible-lint: success
guardrail prod molecule: success
（途中省略：PLAYの表示、Pythonの警告）
--- before: /etc/drift-check-target.conf
+++ after: /etc/drift-check-target.conf
@@ -1,2 +1 @@
 monitored_by=ansible-drift-check
-# 障害対応中（2026-10-31）: 一時的な設定。Gitには戻さない

changed: [target-node1]
（途中省略：ほかのタスクはok）
CONVERGE prod ref=4a53c5461246ed676e87330c8884d8551db98244 terraform_apply_exit_code=-1 ansible_exit_code=0
RECHECK prod=converged plan_exit_code=0 check_exit_code=0 changed=0
（ステップ「Report to issues」）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
no open issue: [drift-detect] prod
```

**実行コマンド**

```plaintext
docker exec target-node1 cat /etc/drift-check-target.conf
docker exec target-node1 cat /etc/gitops20-manual.conf
docker exec target-node1 ls -l /etc/gitops20-manual.conf
```

**▼ 実行結果**

```plaintext
monitored_by=ansible-drift-check
emergency_workaround=enabled
-rw-r--r-- 1 root root 29 Oct 31 05:25 /etc/gitops20-manual.conf
```

### ■ 結果

|手動変更|検知|自動収束の後|
|---|---|---|
|`/etc/drift-check-target.conf`への1行|`changed: target-node1 … ドリフト検知の実演用設定ファイルを配置`として現れた|消えた（`terraform_apply_exit_code=-1`はTerraformの差分がなく動かなかったこと、`ansible_exit_code=0`はAnsibleが戻したことを示す）|
|`/etc/gitops20-manual.conf`|現れなかった|残った|

Gitに戻さなかった手動変更のうち、Playbookが管理しているものは、一時停止を外した後の自動収束で元に戻りました。管理していないファイルは、検知にも収束にも現れず、何も起きないまま残りました。「戻さなかった変更は自動収束で元に戻る」と言えるのは、Playbookやコードが管理している範囲だけです。管理の範囲の外に残ったものを減らす設計は、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)** で扱います。管理していないファイルは、ここで手で消しました。

また、収束の後に差分がないため、Issueは作られていません。手動変更があったことは、一時停止の記録（id 5）と、実行のログにしか残っていません。一時停止の記録は、障害対応があったことを後から追える、パイプラインの中の唯一の記録になります。

### ■ 検証内容：Gitに戻す場合

「Converge Pause」を、`reason`を「障害対応の確認（第20回）：手動変更をGitに戻すまで自動収束から守る」にして起動しました（「Converge Pause」の実行#6、一時停止のid 6）。そのうえで、**[セクション4](#4-自動収束を一時停止する)** と同じ2つの手動変更を、target-node1に加えました。

**実行コマンド**

```plaintext
docker update --restart=always target-node1
docker exec target-node1 sh -c 'echo "# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと" >> /etc/drift-check-target.conf'
for n in target-node1 target-node2 target-node3; do docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' $n; done
docker exec target-node1 cat /etc/drift-check-target.conf
```

**▼ 実行結果**

```plaintext
target-node1
/target-node1 restart=always
/target-node2 restart=no
/target-node3 restart=no
monitored_by=ansible-drift-check
# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと
```

この2つを、コードに書き戻します。手動変更はtarget-node1の1台だけなので、コードでも、target-node1だけに効く形で書きます。

|手動変更|書き戻した場所|
|---|---|
|`restart=always`（Terraformの属性）|モジュールに変数`restart_policies`（既定は空）を足し、`docker_container`の`restart`を`lookup(var.restart_policies, each.key, "no")`にする。prodだけが`{ "target-node1" = "always" }`を渡す|
|設定ファイルへの1行（Ansibleが管理するファイル）|ロールの既定値に`common_setup_drift_check_notes: []`を足し、`content`を1行目に続けてその行を並べる形にする。prodのインベントリの`host_vars/target-node1.yml`だけで、1行を渡す|

**▼ 実行結果**（`git diff`、Terraform）

```plaintext
--- a/terraform/envs/prod/main.tf
+++ b/terraform/envs/prod/main.tf
@@ -37,6 +37,7 @@ module "lab_env" {
   image_build_context = "${path.module}/../.."
   connect_public_key  = file("${path.module}/connect_key.pub")
   operator_public_key = file("${path.module}/../../id_ed25519.pub")
+  restart_policies    = { "target-node1" = "always" }
 }
--- a/terraform/modules/lab_env/main.tf
+++ b/terraform/modules/lab_env/main.tf
@@ -31,6 +31,7 @@ resource "docker_container" "targets" {
   name     = each.key
   image    = docker_image.this.image_id
   env      = []
+  restart  = lookup(var.restart_policies, each.key, "no")
   networks_advanced {
     name = docker_network.this.name
   }
--- a/terraform/modules/lab_env/variables.tf
+++ b/terraform/modules/lab_env/variables.tf
@@ -27,3 +27,9 @@ variable "operator_public_key" {
   type        = string
   description = "authorized_keysに入れる、操作する人の公開鍵"
 }
+
+variable "restart_policies" {
+  type        = map(string)
+  description = "コンテナごとの再起動の方針（指定のないコンテナはno）"
+  default     = {}
+}
```

**▼ 実行結果**（`git diff`、Ansible）

```plaintext
--- a/ansible/roles/common_setup/defaults/main.yml
+++ b/ansible/roles/common_setup/defaults/main.yml
@@ -1,2 +1,3 @@
 ---
 common_setup_env: unknown
+common_setup_drift_check_notes: []
--- a/ansible/roles/common_setup/tasks/drift_check.yml
+++ b/ansible/roles/common_setup/tasks/drift_check.yml
@@ -3,5 +3,9 @@
   become: true
   ansible.builtin.copy:
     dest: /etc/drift-check-target.conf
-    content: "monitored_by=ansible-drift-check\n"
+    content: |
+      monitored_by=ansible-drift-check
+      {% for note in common_setup_drift_check_notes %}
+      {{ note }}
+      {% endfor %}
     mode: "0644"
```

**▼ 実行結果**（`cat -n ansible/inventories/prod/host_vars/target-node1.yml`、新しく作ったファイル）

```plaintext
     1  ---
     2  common_setup_drift_check_notes:
     3    - "# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと"
```

プルリクエストにする前に、手元で、書き戻したコードと実環境が一致するかを確かめました。

**実行コマンド**

```plaintext
for e in dev stg prod; do terraform -chdir=terraform/envs/$e plan -input=false -detailed-exitcode > /tmp/plan-$e.log 2>&1; echo "$e plan_exit_code=$?"; rm /tmp/plan-$e.log; done
cd ansible
for e in dev stg prod; do echo "== $e"; ansible-playbook -i inventories/$e site.yml --check --diff --vault-id "gitops16@$HOME/.config/ansible-vault/gitops16-vault-pass" 2>/dev/null | grep -E '^[+-][^+-]|: ok='; done
```

**▼ 実行結果**

```plaintext
dev plan_exit_code=0
stg plan_exit_code=0
prod plan_exit_code=0
== dev
dev-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== stg
stg-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== prod
target-node1               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

3環境とも`plan`は差分なし、確認モードは5台とも`changed=0`で、差分の行も出ていません。書き戻したコードは、手動変更を加えた後の実環境と一致しています。

この変更をプルリクエスト（PR#124）にし、確認の実行（「GitOps Pipeline」の実行#200）でガードレールとplan、確認モードが通ったことを確かめて、マージしました（マージコミット`d7af032`、「GitOps Pipeline」の実行#201）。そのうえで、緊急時の入力は使わずに、「GitOps Apply」をdev（「GitOps Apply」の実行#116）、stg（「GitOps Apply」の実行#117）、prod（「GitOps Apply」の実行#118）の順に起動しました。prodは、まだ一時停止中（id 6）です。

**▼ 実行結果**（「GitOps Apply」の実行#118、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）

```plaintext
cd608c92ed4364981a23b4d4239a194f694c9ead2cd7ade9f28eae6319f00e02  /home/control/gitops-pending/prod/tfplan

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.
（途中省略：Outputs）
```

**▼ 実行結果**（「GitOps Apply」の実行#118、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
（途中省略：PLAYの表示、Pythonの警告、各タスクはok）
target-node1               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**実行コマンド**

```plaintext
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
.github/scripts/exception.sh active prod; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
 id | env  |                commit_sha
----+------+------------------------------------------
 78 | prod | d7af032e27e316062ed9389cb85ebccffb57bf46
 77 | stg  | d7af032e27e316062ed9389cb85ebccffb57bf46
 76 | dev  | d7af032e27e316062ed9389cb85ebccffb57bf46
(3 rows)

id=6 expires_at=2026-10-31 09:35:07 UTC requested_by=juehara-crypto reason=障害対応の確認（第20回）：手動変更をGitに戻すまで自動収束から守る
exit_code=0
```

一時停止中のprodにも、「GitOps Apply」の適用は通常どおり行われました。書き戻したコードが実環境と一致しているため、Terraformは何も変えず、Ansibleも`changed=0`で、手動変更は残りました。最後に適用したコミットは、3環境とも`d7af032`に進んでいます。

ここで一時停止を解除し（「Converge Pause」の実行#7、id 6は06:19:07 UTCに解除）、`converge`を有効にして「Drift Detect」を起動しました（「Drift Detect」の実行#47）。

**▼ 実行結果**（「Drift Detect」の実行#47、`detect`ジョブから抜粋）

```plaintext
  COMPARE_WITH: last-applied
  CONVERGE: true
（途中省略：環境変数の表示）
== dev
compare_with=last-applied ref=d7af032e27e316062ed9389cb85ebccffb57bf46
（途中省略：planは差分なし）
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== stg
compare_with=last-applied ref=d7af032e27e316062ed9389cb85ebccffb57bf46
（途中省略：planは差分なし）
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== prod
compare_with=last-applied ref=d7af032e27e316062ed9389cb85ebccffb57bf46
（途中省略：planは差分なし）
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（ステップ「Report to issues」）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
no open issue: [drift-detect] prod
```

**実行コマンド**

```plaintext
for n in target-node1 target-node2 target-node3; do echo "== $n"; docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' $n; docker exec $n cat /etc/drift-check-target.conf; done
```

**▼ 実行結果**

```plaintext
== target-node1
/target-node1 restart=always
monitored_by=ansible-drift-check
# 障害対応中（2026-10-31）: 再起動の方針をalwaysに変更。対応が終わるまで戻さないこと
== target-node2
/target-node2 restart=no
monitored_by=ansible-drift-check
== target-node3
/target-node3 restart=no
monitored_by=ansible-drift-check
```

### ■ 結果

一時停止を外した後、収束を有効にした検知でも、3環境とも差分はなく、収束は動きませんでした。target-node1の`restart=always`と「戻さないこと」の1行は、手動変更としてではなく、Gitの記述として残っています。**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション8で1回の実行で戻された2つの変更が、同じ自動収束のもとで残るようになりました。

Gitに戻す流れは、次のとおりです。

|段階|守っているもの|確かめた結果|
|---|---|---|
|一時停止|手動変更が、Gitに戻すまでの間に戻されないこと|一時停止中に「GitOps Apply」の適用も行われたが、書き戻したコードが実環境と一致していたため、何も戻らなかった|
|コードへの書き戻し|手動変更と同じ範囲だけを、コードで表すこと|手元の`plan`と確認モードが3環境とも差分なしになることで、書き戻しが実環境と一致することを、プルリクエストの前に確かめられた|
|通常の経路での適用|書き戻した変更も、レビュー、ガードレール、昇格の順序を通ること|dev、stg、prodの順に、緊急時の入力なしで適用した|
|一時停止の解除|通常の自動収束に戻ること|収束を有効にした検知で、3環境とも差分なし|

一時停止の記録（id 6）の`commit_sha`は、一時停止した時点の最後に適用したコミット`4a53c54`のままです。解除した時点の最後に適用したコミットは`d7af032`で、その間にGitに戻したことが、2つの記録を並べると分かります。

### 書き戻す範囲は、手動変更と同じにする

この検証では、手動変更がtarget-node1の1台だけだったので、コードでもtarget-node1だけに効く形で書き戻しました。仮に、`drift_check.yml`の`content`に1行を足すだけにしていれば、その1行はdev、stg、prodの5台すべてに入り、`docker_container`に`restart = "always"`と書くだけにしていれば、すべてのコンテナの再起動の方針が変わります。それは、手動変更をGitに戻すことではなく、障害対応のついでに新しい変更を加えることです。

書き戻しが手動変更と同じ範囲になっているかは、プルリクエストの前に、手元の`plan`と確認モードが差分なしになるかで確かめられます。差分が出れば、書き戻したコードが、手で加えた変更より広いか、狭いか、違っているかのどれかです。

### 後片付け

検証のために書き戻した変更は、`git revert`で戻しました（戻すコミット`ddba30b`）。プルリクエスト（PR#125）にして、確認の実行（「GitOps Pipeline」の実行#202）とマージの実行（「GitOps Pipeline」の実行#203、マージコミット`7223eb7`）を経て、「GitOps Apply」でdev（「GitOps Apply」の実行#119）、stg（「GitOps Apply」の実行#120）、prod（「GitOps Apply」の実行#121）の順に適用しました。target-node1の`restart`はその場の更新として`no`に戻り、1行も消えています。戻す変更も、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** と同じく、新しいコミットとして同じパイプラインを通しています。

次のセクションでは、この回で作った例外経路と、**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** で整理した場当たり的な回避との違いを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. 場当たり的な回避と設計された例外の違い

この回で作った3つの例外経路と、**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** で整理した場当たり的な回避の違いを整理します。

### どちらも、通常の経路を外れている

**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション3では、パイプラインが設計どおりに止まったときに、止まった状態を回避しようとする操作を3つ挙げ、どれもガードレールを壊す操作だと整理しました。

|場当たり的な回避|何を外しているか|
|---|---|
|`Error acquiring the state lock`を故障と思い込み、ロックを外す|同時に1つの実行しかstateを書き換えないという保護|
|planの判定で止まったので、`allow_destroy`を付けて起動し直す|作り直しや削除を、人が内容を確かめてから通すという判断|
|入口の確認で止まったので、ワークフローからそのステップを外す|適用の前に確かめる条件そのもの|

この回の例外経路も、通常の経路を外れる点では同じです。緊急時の入力は昇格の順序の確認を飛ばし、一時停止は自動収束を止め、手動変更はパイプラインの外から実環境を変えます。外れているかどうかでは、2つは区別できません。

### 違いは、記録・期限・戻し方

2つを分けるのは、外れたことが残るか、外れた状態がいつ終わるか、どうやって通常の経路に戻るかが、外れる前に決まっているかどうかです。

|例外経路|記録|期限|戻し方|
|---|---|---|---|
|昇格の順序の短縮（**[セクション3](#3-gitを経由する高速経路)**）|`gitops.exceptions`に、環境、コミット、理由、起動した人、実行のURL、時刻が残る。理由がなければ、順序の確認で止まる|その1回の実行だけ。入力の値はどこにも残らない|次の起動は、何もしなくても通常の経路になる。dev・stgは、通常の経路で追いつかせる|
|自動収束の一時停止（**[セクション4](#4-自動収束を一時停止する)**、**[セクション5](#5-一時停止そのものがドリフトの原因になる)**）|`gitops.exceptions`に、上に加えて期限が残る。止めている間の差分と、止めている理由が、Issueに残る|必須。1〜1440分。期限を過ぎれば、解除の操作がなくても終わる|人が解除するか、期限が来る。どちらで終わったかも記録から分かる|
|手動変更のバックポート（**[セクション6](#6-手動変更をgitに戻す)**）|手動変更が、プルリクエストとコミットとして残る|一時停止の期限まで|Gitに戻すか、捨てるかを選ぶ。どちらでも、最後に適用したコミットと実環境が一致する状態に戻る|

**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** の3つの回避には、このどれもありません。ロックを外したことも、`allow_destroy`を付け直した理由も、どこにも残りません。外したステップは、誰かが戻すまで外れたままです。どうやって通常の経路に戻るかも、決まっていません。

### 短縮しても、外さないものがある

もう1つの違いは、例外経路の中でも外さないものが決まっていることです。

|例外経路|外したもの|外さなかったもの|
|---|---|---|
|昇格の順序の短縮|前の環境に同じコミットを適用し終えたかの確認|プルリクエストの確認、ガードレールの確認、planの判定、保存したplanの適用。**[セクション3](#3-gitを経由する高速経路)** では、ansible-lintが失敗したコミットは、緊急時の入力があってもprodに届かなかった|
|自動収束の一時停止|その環境の自動収束|検知とIssueへの記録。「GitOps Apply」による通常の適用|
|手動変更|パイプラインを通さずに変えること（障害対応の最中だけ）|Gitに戻すときは、プルリクエスト、ガードレール、昇格の順序をすべて通す|

場当たり的な回避は、止まった箇所そのものを外します。設計された例外経路は、止まる理由のうち、緊急時に待てないものだけを、記録を残して短縮します。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** で「設計どおりの停止で直すのは、パイプラインではなく手順」と整理しました。この回の例外経路は、緊急時の手順を、パイプラインの中に正規に用意したものです。

### 例外経路のメッセージも、切り分けの層に乗せる

この回で足した確認は、**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** で整理した4つの層のうち、ガードレールの層のメッセージとして出しています。

|メッセージ|出す場所|意味|
|---|---|---|
|`::error::emergency requires a reason`|「GitOps Apply」の「Check promotion order」|緊急時の入力に理由がないため、設計どおりに止めた|
|`::warning::promotion order skipped by emergency: …`|同上|緊急時の入力で順序を飛ばし、記録した|
|`HOLD <環境> converge-pause: …`|「Drift Detect」の収束のループ|一時停止中のため、収束を飛ばした|

どれも、故障ではなく、例外経路が設計どおりに動いたことを示すメッセージです。止まったときに、これを故障と思い込んで回避しようとすれば、例外経路そのものを場当たり的な回避で外すことになります。

### 例外経路でも防げないもの

設計された例外経路は、外れたことを記録に残しますが、外れること自体を防ぐ仕組みではありません。次のものは、この回の形でも残ります。

* **例外経路を使わずに外れること**：一時停止をせずに手で直せば、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション8と同じく、何も残らないまま戻されます。手元から`terraform apply`を実行すれば、**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** と同じく、最後に適用したコミットの記録に入りません。例外経路は、使われたときにだけ記録を残します
* **使える人を分けられないこと**：緊急時の入力も、「Converge Pause」も、ワークフローを起動できる人なら誰でも使えます。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** と同じく、環境ごとに起動できる人を分けることはできません
* **記録そのものの保護**：`gitops.exceptions`は、`gitops.applied`と同じPostgreSQLにあります。直接書き込める人は、記録を足すことも消すこともできます
* **例外経路の変更**：この回で「GitOps Apply」に入力を足し、「Converge Pause」を足したのは、ワークフローのファイルの変更です。**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** のセクション7で整理したとおり、ワークフローのファイルの変更はガードレールの対象になりません。例外経路を緩める変更も、プルリクエストのレビューでしか止められません

記録が残ることの価値は、外れたことを後から振り返れる点にあります。`gitops.exceptions`を定期的に見れば、どの環境で、誰が、どれだけの頻度で通常の経路を外れているかが分かります。例外が多い環境は、通常の経路が障害対応に合っていないことを示しています。

次のセクションでは、この設計が、クラウドのプロバイダーでも変わらないことを示します。

---

[↑ 目次に戻る](#-目次)

---

## 8. クラウドでも同じ設計で両立できる

この回で作った例外経路が、クラウドのプロバイダーでも同じ形で成り立つことを整理します。

### クラウドでの手動変更の経路

この回の検証では、障害対応の手動変更を、`docker update`（Terraformが管理している属性）と`docker exec`（Ansibleが管理しているファイル）で加えました。クラウドでは、同じ2種類の手動変更が、次のような経路で起きます。

|この回の検証|クラウドでの経路|変わるもの|
|---|---|---|
|`docker update --restart=always`|クラウドのコンソールやCLIから、インスタンスやネットワークの設定を直接変える|Terraformが管理している属性|
|`docker exec`で設定ファイルを書き換える|SSHや、クラウドが用意するインスタンスへのセッション機能でログインし、ファイルを書き換える|Ansibleが管理しているファイル|

障害対応では、普段の権限では足りない操作のために、緊急用のアカウント（ブレイクグラスアカウントと呼ばれます）を使うこともあります。どの経路でも、パイプラインの外から実環境を変える点は、この回の`docker update`や`docker exec`と同じです。Terraformが管理している属性の変更は`plan`に、Ansibleが管理しているファイルの変更は確認モードに、それぞれ差分として現れ、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** の自動収束で戻されます。

### 例外経路は、プロバイダーに依存しない

この回で作ったものは、どれもプロバイダーの外側にあります。

|作ったもの|置き場所|プロバイダーとの関係|
|---|---|---|
|昇格の順序の短縮|「GitOps Apply」の入力と、ステップ「Check promotion order」|プロバイダーを呼ぶ前の、入口の確認の中にある|
|自動収束の一時停止|`gitops.exceptions`と、「Drift Detect」の収束のループ|収束を始めるかどうかの判断の中にある|
|バックポート|プルリクエストと、通常の経路での適用|書き戻す先がAWSやGCPのリソースの属性になるだけで、流れは同じ|

Terraformのプロバイダーを、DockerからAWSやGCPに書き換えても、入口の確認、収束の判断、プルリクエストの流れは変わりません。変わるのは、書き戻すコードがクラウドのリソースの属性になることと、手動変更の経路が増えることです。

### 監査ログがあっても、例外の記録は要る

クラウドには、APIの操作を記録する監査ログを持つものが多くあります。監査ログからは、誰が、いつ、何を変えたかが分かります。ただし、次のことは分かりません。

* なぜ変えたのか（障害対応のためか、戻し忘れか）
* いつまでその状態を許すのか
* Gitに戻すのか、捨てるのか

**[ドリフトシリーズ第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)** で、Ansibleの実行結果からは「戻し忘れの修正」と「意図した緊急対応の無効化」を区別できないと整理しました。監査ログも、変更の事実は残しますが、その意図と期限は残しません。一時停止の理由と期限、緊急時の入力の理由を、パイプラインの側で記録するのは、この区別をつけるためです。

### 上位プランの機能との関係

この回では、GitHubの無料プランの非公開リポジトリで使える機能だけで、例外経路を作りました。上位のプランや公開リポジトリでは、環境（Environments）ごとに承認者を指定する機能があります。これを使えば、緊急時の入力でprodに適用できる人や、一時停止を起動できる人を、環境ごとに絞れます（この回では確かめていません）。**[セクション7](#7-場当たり的な回避と設計された例外の違い)** で挙げた「使える人を分けられない」という限界は、こうした機能で狭められます。それでも、記録・期限・戻し方を決めておく必要は変わりません。承認者を絞っても、承認された例外がいつ終わり、どう戻るのかは、承認とは別に決める必要があるためです。

---

[↑ 目次に戻る](#-目次)

---

## 9. まとめ

この回で整理した内容を確認します。

* 障害対応では、通常の経路を全部待つと遅く、通常の経路を外れて手で直すと、自動収束に戻されるか、何も記録に残らない。この板挟みに対して、障害対応の変更の入り方を、Gitを経由する高速経路と、Gitを経由しない手動変更の2つに分け、どちらにも「誰が、いつ、なぜ外れたかが残ること」と「期限が来たら通常の経路に戻ること」を条件として課す
* Gitを経由する高速経路では、昇格の順序だけを短縮し、プルリクエスト、ガードレール、planの判定、保存したplanの適用は短縮しない。緊急時の入力と理由を付けて「GitOps Apply」を起動すると、stgを経ずにprodへ適用でき、例外として`gitops.exceptions`に記録された。理由がなければ止まり、ansible-lintが失敗したコミットは、緊急時の入力があってもガードレールの確認で止まった。止まった実行でも、例外を使おうとしたことは記録に残った。緊急時の入力が効くのはその1回の実行だけで、dev・stgは通常の経路で追いついた
* Gitを経由しない手動変更のために、自動収束を環境ごとに一時停止する。一時停止は、理由と期限を必須にして`gitops.exceptions`に記録する。一時停止したprodでは、手動変更が戻されず、検知は続いてIssueに「一時停止中のため戻していない」と理由と期限が残った。一時停止していないdevでは、同じ手動変更が1回の実行で戻された
* 一時停止そのものは、解除し忘れると自動収束を止め続ける新しいドリフトの原因になる。検知は止めず、期限を必須にし、期限切れの判定に解除の操作を要らないようにした。期限を過ぎた後の最初の収束で、解除の操作をしなくても手動変更は戻った。期限が来ただけでは何も戻らず、戻る時刻は収束が次にいつ動くかで決まる
* 手で加えた変更は、期限内にGitに戻すか、捨てるかを決める。戻さなかった変更のうち、Playbookが管理しているものは自動収束で戻ったが、管理していないファイルは検知にも現れずに残った。戻す場合は、手動変更と同じ範囲だけをコードに書き戻し、手元の`plan`と確認モードが差分なしになることで、書き戻しが実環境と一致することを確かめてから、通常の経路で適用する。一時停止を外した後も、手動変更はGitの記述として残った
* 設計された例外経路と場当たり的な回避は、どちらも通常の経路を外れるが、記録・期限・戻し方が決まっているかどうかで区別される。例外経路の中でも、外さないものが決まっている。一方で、例外経路を使わずに外れることや、使える人を分けられないことは、この形でも防げない
* クラウドでは、コンソールやセッション機能、緊急用のアカウントによる直接の操作が、手動変更の経路になる。例外経路はプロバイダーの外側にあり、プロバイダーを問わず同じ形で組み込める。監査ログが残す変更の事実とは別に、なぜ、いつまで、どう戻すかを、パイプラインの側で記録する

---

[↑ 目次に戻る](#-目次)

---

## 10. 次回予告

本シリーズの **[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** では、環境ごとに最後に適用したコミットに限って、検知した差分だけを戻す自動収束を作りました。その最後に、障害対応で加えた手動変更も、書き残したメモも、自動収束が1回の実行で戻し、Issueにも何も残らないことを確かめました。第20回となる今回は、障害対応とGitOpsのパイプラインを両立させる設計を扱いました。昇格の順序だけを記録付きで短縮するGitを経由する高速経路と、理由と期限を持つ自動収束の一時停止を作りました。一時停止中も検知を止めず、期限が来れば解除の操作なしに通常の自動収束へ戻ることを確かめました。そのうえで、手で加えた変更をGitに戻した場合と戻さなかった場合を確かめ、場当たり的な回避との違いを、記録・期限・戻し方の有無で整理しました。最後に、この設計がクラウドのプロバイダーでも変わらないことを示しました。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)** では、今回の **[セクション6](#6-手動変更をgitに戻す)** で、Gitに戻さなかったのに検知にも収束にも現れず、そのまま残ったファイルのような、「記述・記録されていない乖離」を扱います。第4部の最終回、そしてシリーズの最終回として、**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** の「防ぐ」をGitOps上で実装します。管理の外にあるものを、実際の状態とPlaybook・tfstateとの突き合わせで洗い出し、「取り込む」「削除する」「管理外と宣言する」に振り分けて、すべてをGitに記録します。

**[次回：第21回：検知できないドリフトを減らす：管理対象の範囲を広げる設計](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)　｜　[次の記事：【GitOps編】第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**

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
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**|定期実行でドリフトを自動検知する|環境ごとに「最後に適用したコミット」のコードで実環境を比べ、結果を「差分なし」「差分あり」「検知失敗」の3つに分ける定期検知を作る。stateのロックとの衝突を同時実行のグループとロックの待ち時間で扱い、検知が止まったことをホステッドランナーの確認役から気づけるようにする。結果を環境ごとに1つのIssueに残し、昇格の途中の複数環境でも環境ごとに独立して検知できることを確かめる。Ansible×Terraformシリーズ第37回の深掘り版として位置づける。|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**|ドリフトを検知したら自動収束させる|収束先をmainではなく環境ごとに最後に適用したコミットに限り、検知の時点で保存したplanで検知した差分だけを戻す自動収束を作る。作り直し・削除・作成と検知失敗は人に返し、ガードレールの結果を確かめてから戻す。収束の後の再検知で、収束しないPlaybookによる繰り返しを止める。自動収束が直せないものを整理し、障害対応の手動変更まで元に戻されることを実機で確かめる。|
|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)**|緊急対応の手動変更とGitOpsを両立させる|障害対応の変更を、Gitを経由する高速経路と、Gitを経由しない手動変更に分け、どちらにも記録と期限を課す。昇格の順序だけを記録付きで短縮し、ガードレールと保存したplanの適用は短縮しない。自動収束を理由と期限を持つ形で一時停止し、一時停止中も検知を続け、期限が来れば解除の操作なしに戻ることを確かめる。手動変更をGitに戻した場合と戻さなかった場合を実機で確かめ、場当たり的な回避との違いを記録・期限・戻し方で整理する。|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**|検知できないドリフトを減らす：管理対象の範囲を広げる設計|検知も自動収束もできない「記述・記録されていない乖離」を扱い、ドリフトシリーズ第4回の「防ぐ」をGitOps上で実装する。管理外のものを実際の状態とPlaybook・tfstateとの突き合わせで洗い出し、「取り込む」「削除する」「管理外と宣言する」に振り分けてすべてをGitに記録する。第4部・シリーズの最終回。|

---

[↑ 目次に戻る](#-目次)

---