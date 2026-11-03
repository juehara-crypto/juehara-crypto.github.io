---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第21回：検知できないドリフトを減らす：管理対象の範囲を広げる設計'
description: '検知にも自動収束にも現れない「記述・記録されていない乖離」を、GitOpsのパイプラインの上で減らす。操作対象の実際の状態をPlaybook・tfstateと突き合わせて管理外のものを洗い出し、「取り込む」「削除する」「管理外と宣言する」に振り分けて、すべてをGitに記録する。洗い出しを定期検知と並べて動かし、ignore_changesと削除用タスクも見直しの対象にする。ドリフトシリーズ第4回の「防ぐ」を実装し、第4部とシリーズを締めくくる回。'
pubDate: 2026-10-31
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'ドリフト', '構成管理']
seriesId: 'ansible-gitops-part4'
seriesNo: 21
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/'
nextPost: ''
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
2. [検知も収束もできない乖離が残っている](#2-検知も収束もできない乖離が残っている)
3. [管理外のものを見つける](#3-管理外のものを見つける)
4. [見つけたものを3つに振り分ける](#4-見つけたものを3つに振り分ける)
5. [定期的な洗い出しと検知を並べる](#5-定期的な洗い出しと検知を並べる)
6. [意図的に外した属性と削除用タスクを見直す](#6-意図的に外した属性と削除用タスクを見直す)
7. [どこまで管理するかを決める](#7-どこまで管理するかを決める)
8. [クラウドでも同じ設計で範囲を狭められる](#8-クラウドでも同じ設計で範囲を狭められる)
9. [まとめ](#9-まとめ)
10. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#10-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

TerraformとAnsibleのパイプラインに、ドリフトの定期検知と自動収束を入れていて、

* 検知は毎日動いていて、差分ありの報告は来ていない
* 差分が出たときは、自動収束が、最後に適用したコミットの状態に戻す
* よって、差分が出ていない環境は、Gitに書いたとおりの状態になっている

と考えていないでしょうか。

ドリフトを扱う記事の多くは、差分を検知して直す仕組みを中心にしています。検知の対象にすら入っていないもの、つまり管理の外にあるものを、どう見つけ、どう減らすかは、あまり扱われていません。検知と自動収束を入れたパイプラインを運用していても、次のような場面にぶつかります。

* 誰が入れたか分からないパッケージが、サーバーに残っていた
* Terraformの外で作られたコンテナが、動き続けていた
* revertした後の残骸が、いつまでも残っている
* `ignore_changes`を付けた理由が、誰にも分からない

これらは、作業の記録漏れや、引き継ぎの問題に見えます。共通しているのは、TerraformもAnsibleも、コードに記述されたもの、tfstateに記録されたものとしか比べておらず、その外にあるものは、ずれていても「差分なし」と同じ表示になる点です。検知も自動収束も、この表示の上に作られています。

Ansibleが比べる範囲と、管理の外で起きる変化は、**[「Ansibleは冪等なのに、なぜサーバは壊れていくのか」](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)**（以下、ドリフトシリーズ）で扱いました。

|回|扱った内容|
|---|---|
|**[ドリフトシリーズ第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-01/)**|手で書き換えた設定ファイルを、`template`のPlaybookはファイル全体ごと元に戻し、`lineinfile`のPlaybookは管理している行だけを戻して、管理していない行の手動変更を残すことを確かめた。Playbookの実行結果は、Playbookが管理している範囲についての結果で、ファイル全体の状態を保証しないと整理した|
|**[ドリフトシリーズ第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-03/)**|どのタスクにも記述されていないファイルをcronジョブで書き換えても、`--check`を使わない通常の実行でさえ、`changed=0`のまま通過することを確かめた。`changed=0`は、Ansibleが管理している範囲に差分がなかったことを意味し、サーバー全体が正しい状態にあることを意味しないとした|
|**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)**|ドリフトへの対処を、防ぐ・検知する・修正するの3つの設計に整理した。防ぐ設計の基本として、どのファイル・パッケージ・サービスをAnsibleで管理するかを明示し、管理していない領域を作らないことを挙げた|

管理の粒度の違いは、**[「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜](https://qiita.com/juehara-crypto/items/d77fa93e82ea4a33ef4f)**（以下、冪等性シリーズ）で扱いました。

|回|扱った内容|
|---|---|
|**[冪等性シリーズ第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-06/)**|`lineinfile`は特定の行への局所的な操作で、ファイル全体をあるべき状態として扱う`template`や`copy`とは、管理の粒度が違うことを整理した。`lineinfile`を使う場合は、ファイル全体の状態は保証されないと認識しておく必要があるとした|

TerraformとAnsibleを組み合わせた環境での検知の範囲は、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）で扱いました。

|回|扱った内容|
|---|---|
|**[Ansible×Terraformシリーズ第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**|コンテナの中にファイルを作っても、`terraform plan`は「No changes」を返すことを確かめた。Playbookが管理している設定ファイルの手動変更は、`--check --diff`だけが示した。TerraformとAnsibleの検知の範囲は互いに独立していて、片方の管理範囲の変化は、もう片方に伝わらないと整理した|

本シリーズでは、GitHubの非公開リポジトリに置いたTerraformとAnsibleのコードを、GitHub Actionsのワークフローを通してインフラに届けるパイプラインを作ってきました。ワークフローは、操作対象と同じネットワークに置いたself-hostedランナーで動き、操作対象は、dev、stg、prodの3つの環境に分けたDockerのコンテナです。この回で前提にする仕組みは、次のとおりです。

|仕組み|置き場所|役割|
|---|---|---|
|「GitOps Pipeline」|GitHub Actionsのワークフロー（self-hostedランナー）|プルリクエストで、`terraform plan`とAnsibleの確認モードを実行する。マージで、環境ごとにplanを保存し、承認待ちを作る|
|「GitOps Apply」|GitHub Actionsのワークフロー（self-hostedランナー、手動で起動）|選んだ環境の承認待ちを、入口の確認（昇格の順序、プルリクエストを通ったか、ガードレールの結果、planの判定）を通ったときだけ適用する。緊急時の入力と理由を付けたときだけ、昇格の順序の確認を、記録を残して飛ばす|
|「Drift Detect」|GitHub Actionsのワークフロー（self-hostedランナー、毎日のスケジュールと手動の起動）|環境ごとに最後に適用したコミットのコードで、実環境との差分を検知し、結果を環境ごとに1つのIssueに残す。手動の起動で収束を有効にしたときは、検知した差分を自動で戻す|
|「Drift Detect Watch」|GitHub Actionsのワークフロー（ホステッドランナー）|「Drift Detect」が最後に成功した時刻を確かめ、検知が止まったことを知らせる|
|「Converge Pause」|GitHub Actionsのワークフロー（self-hostedランナー、手動で起動）|環境ごとの自動収束を、理由と期限を付けて一時停止する。期限の前に解除することもできる|
|最後に適用したコミットの記録|tfstateと同じPostgreSQLの表（`gitops.applied`）|環境ごとに、どのコミットを、どの実行で適用したかを残す|
|例外の記録|同じPostgreSQLの表（`gitops.exceptions`）|昇格の順序を飛ばしたことと、自動収束の一時停止を、誰が、いつ、なぜ、いつまで行ったかとともに残す|
|承認待ち|ランナーのホームディレクトリ（`~/gitops-pending/`）|マージで作ったplanとコミットを、承認されるまで環境ごとに置いておく|

管理の外に残るものについては、これまでの回で、次のように扱ってきました。

|部|回|扱った内容|
|---|---|---|
|第1部|**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)**|Playbookのどのタスクにも書かれていないファイル`/etc/gitops-unmanaged.conf`を作り、Git、Terraform、Ansibleのいずれも検出しないことを確かめた。「Gitが唯一の真実」と言えるのは、Gitに記述されている範囲の中だけだとした|
|第2部|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|イメージの`build`を`ignore_changes`に入れ、`context`の文字列が変わっただけで、イメージとコンテナが作り直されるのを避けた。その代わり、`build`の中身を変えても、イメージは作り直されない形になった|
|第2部|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**|`git revert`で戻るのは、revertの後のコードに元の状態が書かれているものだけで、タスクで足したユーザーやファイルは残ることを確かめた。残ったものは「消す」と書いたタスクで消し、消すタスクを外してよいのは、それを含むコミットがすべての環境に適用されてからだとした|
|第4部|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)**|ドリフトを、Terraformの`plan`で検出できるもの、Ansibleの`--check`で検出できるもの、どちらでも検出できないもの（記述・記録されていない要素、revertの残骸、`ignore_changes`で意図して外した属性）の3つに分けた。3つ目は「防ぐ」設計でしか扱えないとした|
|第4部|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**|環境ごとに最後に適用したコミットのコードで実環境を比べる定期検知「Drift Detect」を作り、結果を「差分なし」「差分あり」「検知失敗」の3つに分けて、環境ごとに1つのIssueに残す形にした|
|第4部|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**|「Drift Detect」に、最後に適用したコミットへ戻す自動収束を加えた。収束しないタスクを取り除いた後も、そのタスクが置いたファイルは操作対象に残り、検知にも収束にも現れないため、手で消した|
|第4部|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)**|障害対応のために、昇格の順序だけを記録付きで飛ばす高速経路と、理由と期限を持つ自動収束の一時停止を作った。一時停止を外した後、Gitに戻さなかった手動変更のうち、Playbookが管理している1行は自動収束で戻ったが、どのタスクにもない`/etc/gitops20-manual.conf`は、検知にも収束にも現れずに残った|

**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** から **[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** で作った検知、自動収束、例外経路は、どれも`plan`と確認モードが差分として表示したものの上に作っています。**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** で整理した3つの検出範囲のうち、扱えるのは前の2つだけです。**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** と **[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** で残ったファイルは、どちらも3つ目の範囲にあり、手で消すまで、パイプラインのどこにも現れませんでした。**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** の3つの設計のうち、第4部では「検知する」と「修正する」を作ってきましたが、「防ぐ」はまだ扱っていません。

第21回となる今回は、第4部の最終回、そしてシリーズの最終回として、この「防ぐ」を、GitOpsのパイプラインの上で扱います。まず、検知も自動収束もできない乖離が、どこに残っているかを整理します。次に、操作対象の実際の状態を、Playbookとtfstateに記述・記録されている範囲と突き合わせて、管理の外にあるものを洗い出します。そのうえで、見つけたものを「取り込む」「削除する」「管理外と宣言する」の3つに振り分け、どれを選んだかをGitに記録します。続けて、洗い出しを定期検知と並べて動かす形を作り、`ignore_changes`で外した属性と、revertの残骸を消すための削除用タスクを見直します。さらに、何を管理の対象にし、何を管理外と宣言するかの判断の基準を整理し、最後に、この設計がクラウドのプロバイダーでも変わらないことを示します。

正確に言うと、**記述・記録されていない乖離は、検知の仕組みをどれだけ整えても、検知の結果に現れません。減らすには、見えない範囲そのものを狭めるしかありません**。この回で扱う問いは、「検知も自動収束もできない乖離を、どうすれば減らせるのか」です。

次のセクションでは、検知も自動収束もできない乖離が、どこに残っているかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 検知も収束もできない乖離が残っている

**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** で「どちらでも検出できない」とした範囲に、何が残っているのかを、これまでの回の結果から整理します。

### どちらでも検出できない範囲を、4つに分ける

**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** のセクション7では、Terraformの`plan`でもAnsibleの`--check`でも検出できない範囲に、記述・記録されていない要素、revertの残骸、`ignore_changes`で意図して外した属性の3つが入るとしました。この回では、1つ目を、Ansibleの側とTerraformの側に分けて扱います。どちらも「記述・記録されていない」ことは同じですが、**[セクション3](#3-管理外のものを見つける)** で見つけるときの手段が違うためです。

|乖離|これまでの例|`plan`と`--check`に現れない理由|
|---|---|---|
|記述されていない要素|タスクに記述されていないパッケージ・ファイル・サービス。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** の`/etc/gitops-unmanaged.conf`、**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** のセクション6の`/etc/gitops20-manual.conf`、**[ドリフトシリーズ第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-03/)** のcronジョブが書き換えたファイル|`--check`が比べるのは、タスクに書かれたものだけ。tfstateには、コンテナの中のファイルやパッケージを示す項目がない|
|記録されていないリソース|tfstateに記録されていないリソース。Terraformの外で作られたコンテナ（**[セクション3](#3-管理外のものを見つける)** で確かめる）|`plan`が比べるのは、コードに書かれたリソースと、tfstateに記録されたリソースだけ。Terraformの外で作られたリソースは、どちらにもない|
|revertの残骸|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** のユーザー`gitops11`と`/etc/gitops11-rollback.conf`、コンテナのラベル。**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション7の`/etc/gitops19-nonconverge.conf`|入れたタスクやブロックを取り除いた時点で、どのコードにも書かれていないものになる。ラベルは、tfstateに記録が残っていても、コードに書かれていない属性として比べられなかった|
|外した属性|`ignore_changes`で意図して外した属性。本シリーズのモジュールで外している、イメージの`build`とコンテナの`network_mode`（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** のセクション7）|コードとtfstateに書かれていても、`plan`の判断から外している|

1つ目と2つ目は、外から持ち込まれたものです。手で加えたもの、別の仕組みが書き換えたもの、Terraformの外で作られたものが、ここに入ります。3つ目は、パイプラインを通した変更が自分で作り出したものです。**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** のセクション4で整理したとおり、revertのコミットは`gitops.applied`に適用済みとして記録されるため、残骸があることは記録からも見えません。4つ目は、作り直しを避けるために、意図して見ないことにした範囲です。

### 第18回〜第20回の仕組みは、どれも届かない

**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** から **[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** で作った仕組みが、この4つに対して何をするかを並べます。

|仕組み|動くきっかけ|4つの乖離に対して|
|---|---|---|
|定期検知（**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**）|`plan`の終了コードと、確認モードの`changed`|どちらにも現れないため、「差分なし」と判定し、Issueも作らない|
|自動収束（**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**）|検知の結果が「差分あり」の環境|検知が「差分なし」と判定するため、その環境に何もしない。戻す先の最後に適用したコミットにも書かれていないため、動いたとしても消せない|
|例外経路（**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)**）|人が起動する高速経路と一時停止|一時停止の記録には、誰が、なぜ、いつまで止めたかが残るが、どのファイルを変えたかは残らない。一時停止を外した後も、管理していないものは残る|

**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** のセクション6では、Gitに戻さなかった手動変更のうち、管理していないファイルは、収束の後も残り、Issueも作られませんでした。手動変更があったことは、一時停止の記録と実行のログにしか残っていません。**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** のセクション7の`/etc/gitops19-nonconverge.conf`も、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** の残骸も、最後は手で消すか、消すタスクを書いて消しています。どれも、人が残っていることを知っていたから消せたものです。知らなければ、検知の結果にも、Issueにも、適用の記録にも現れないまま残ります。

### 「防ぐ」は、管理の範囲をはっきりさせること

**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** では、防ぐ設計の基本として、どのファイル・パッケージ・サービスをAnsibleで管理するかを明示し、管理していない領域を作らないことを挙げました。この4つの乖離に当てはめると、やることは次の2つになります。

* 管理の外にあるものを、見つける
* 見つけたものを、管理の中に入れるか、管理の外にあると決めて、その決定を記録する

検知は、比べる相手が記述・記録されているものに対して働きます。そのため、検知の仕組みを強くしても、この4つは現れません。管理の範囲そのものを広げるか、管理の外にあることまで記録するかで、見えない範囲を狭めることになります。

次のセクションでは、操作対象の実際の状態を、Playbookとtfstateに記述・記録されている範囲と突き合わせて、管理の外にあるものを見つけます。

---

[↑ 目次に戻る](#-目次)

---

## 3. 管理外のものを見つける

操作対象とDockerの実際の状態を、Playbook・Terraformのコード・tfstateに記述・記録されている範囲と突き合わせて、管理の外にあるものを洗い出します。

### 何と突き合わせるか

**[セクション2](#2-検知も収束もできない乖離が残っている)** の4つの乖離のうち、この回で洗い出すのは、外から持ち込まれた1つ目と2つ目です。どちらも、管理の範囲を先に決め、実際の状態からそれを差し引いて、残ったものを管理外の候補とします。

|対象|実際の状態|差し引く範囲|
|---|---|---|
|操作対象の中（Ansibleの側）|パッケージの一覧と、`/etc`の下のファイル|イメージから作った直後の状態、Playbookが扱うパス、Terraformがコンテナに置くパス|
|Dockerのリソース（Terraformの側）|コンテナ、イメージ、ネットワーク|3環境のtfstateに記録されているもの|

操作対象の中は、TerraformがDockerのイメージから作ったコンテナです。イメージに入っていたものは、Terraformのコードが指定したイメージの中身として、管理の範囲に入ります。そこで、同じイメージから一時的なコンテナを作り、その状態を比べる基準にします。基準との差のうち、Playbookのタスクが扱うパスと、Terraformがコンテナに置くパスを差し引けば、残るのは、どの記述にもない変化です。

範囲は、次のように決めました。

* ファイルは、`/etc`の下だけを比べる。比べる範囲を決めなければ、ログや一時ファイルのように、動いているだけで変わるものがすべて差に入るため
* パッケージは、`dpkg-query`の一覧で比べる
* サービスは比べない。このコンテナは`sshd`だけを動かしていて、サービスを管理する仕組みが動いていないため

### ■ 検証内容：管理外のものがない状態で、基準との差を見る

まず、手を加えていない5台で、イメージから作った直後の状態との差を見ました。イメージ側の状態は、`docker run --rm`で一時的なコンテナを作って読みます。このコンテナは読み終わると消えます。

**実行コマンド**

```plaintext
for n in dev-node1 stg-node1 target-node1 target-node2 target-node3; do img=$(docker inspect -f '{{.Image}}' $n); echo "== $n"; diff <(docker run --rm --entrypoint dpkg-query "$img" -W -f '${Package}\n' | sort) <(docker exec $n dpkg-query -W -f '${Package}\n' | sort) > /dev/null; echo "pkg_diff_exit_code=$?"; diff <(docker run --rm --entrypoint sh "$img" -c 'find /etc -type f -exec sha256sum {} + | sort -k2') <(docker exec $n sh -c 'find /etc -type f -exec sha256sum {} + | sort -k2') | awk '/^[<>]/{print $1, $3}'; done
```

**▼ 実行結果**（`<`はイメージ側、`>`は操作対象側）

```plaintext
== dev-node1
pkg_diff_exit_code=0
> /etc/drift-check-target.conf
> /etc/gitops-env.conf
< /etc/hostname
< /etc/hosts
> /etc/hostname
> /etc/hosts
> /etc/init_marker
< /etc/passwd-
> /etc/passwd-
< /etc/resolv.conf
> /etc/resolv.conf
< /etc/shadow
< /etc/shadow-
> /etc/shadow
> /etc/shadow-
（途中省略：stg-node1、target-node1〜3も、dev-node1と同じ）
```

5台とも、パッケージの差はなく、`/etc`の下の差は同じ形でした。差のあったファイルを、出どころで分けると、次のとおりです。

|出どころ|ファイル|記述にあるか|
|---|---|---|
|Playbook|`/etc/drift-check-target.conf`、`/etc/gitops-env.conf`|ある。Playbookのタスクが`copy`で置く|
|Terraform|`/etc/init_marker`|ある。Terraformのコードで、コンテナを作るときに置く|
|Playbookの副作用|`/etc/shadow`、`/etc/shadow-`、`/etc/passwd-`|ない。ユーザー`ansible`のパスワードの設定で書き換わる（後の2つはバックアップ）|
|Docker|`/etc/hostname`、`/etc/hosts`、`/etc/resolv.conf`|ない。コンテナの起動のたびにDockerが書く|

`/etc/init_marker`は、Playbookのどのタスクにもありません。リポジトリを探すと、Terraformのモジュールにありました。

**▼ 実行結果**（`cat -n terraform/modules/lab_env/main.tf`から抜粋）

```plaintext
    29  resource "docker_container" "targets" {
（途中省略）
    41    upload {
    42      file    = "/home/ansible/.ssh/authorized_keys"
    43      content = "${var.operator_public_key}\n${var.connect_public_key}"
    44    }
    45    upload {
    46      file    = "/etc/init_marker"
    47      content = "init_version=v1\n"
    48    }
（途中省略）
```

`docker_container`の`upload`で、コンテナを作るときに置いているファイルです。操作対象の中のファイルでも、記述しているのがAnsibleとは限りません。

Playbookが扱うパスは、確認モードの結果から取り出せます。**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の検知で使っている`ansible.posix.json`で結果をJSONにすると、`copy`のタスクは`dest`に、`file`のタスクは`path`にパスが入ります。

**実行コマンド**

```plaintext
cd ansible
ANSIBLE_STDOUT_CALLBACK=ansible.posix.json ansible-playbook -i inventories/dev site.yml --check --vault-id "gitops16@$HOME/.config/ansible-vault/gitops16-vault-pass" 2>/dev/null | jq -r '.plays[].tasks[] | .task.name as $t | .hosts | to_entries[] | [.key, $t, (.value.dest // .value.path // .value.name // "-")] | @tsv'
```

**▼ 実行結果**

```plaintext
dev-node1       common_setup : ドリフト検知の実演用設定ファイルを配置   /etc/drift-check-target.conf
dev-node1       common_setup : 環境の名前を書いたファイルを配置 /etc/gitops-env.conf
dev-node1       common_setup : ロールバック確認用のユーザーを削除       gitops11
dev-node1       common_setup : ロールバック確認用のファイルを削除       /etc/gitops11-rollback.conf
dev-node1       common_setup : ユーザーansibleのパスワードを設定        -
dev-node1       疎通確認        -
```

Terraformがコンテナに置くパスは、tfstateの`upload`の`file`から取り出せます。この2つを差し引けば、記述にある3つのファイルは候補から外れ、記述にない6つが残ることになります。

### ■ 検証内容：洗い出しのスクリプトを作る

ここまでの突き合わせを、スクリプト`.github/scripts/find-unmanaged.sh`にまとめました。

**▼ 実行結果**（`cat -n .github/scripts/find-unmanaged.sh`）

```plaintext
     1  #!/usr/bin/env bash
     2  # 管理の外にあるものを洗い出す
     3  #   find-unmanaged.sh hosts <dev|stg|prod> <コードのディレクトリ>
     4  #       操作対象のパッケージとファイルを、イメージから作った直後の状態と比べ、
     5  #       Playbookが扱うパスと、Terraformがコンテナに置くパスを差し引いて表示する
     6  #   find-unmanaged.sh docker <コードのディレクトリ>
     7  #       Dockerのコンテナ・イメージ・ネットワークのうち、3環境のtfstateに記録がないものを表示する
     8  # 出力       UNMANAGED <環境> <ホスト> <種類> <名前> <状態>
     9  # 終了コード 0=管理外なし、1=管理外あり、2=使い方の誤り・洗い出しの失敗
    10  set -Eeuo pipefail
    11  trap 'exit 2' ERR
    12  export LC_ALL=C.UTF-8
    13  SCAN_DIRS="${SCAN_DIRS:-/etc}"
    14  tmp=$(mktemp -d)
    15  trap 'rm -rf "$tmp"' EXIT
    16
    17  usage() {
    18    echo "usage: find-unmanaged.sh hosts <dev|stg|prod> <code_dir> | find-unmanaged.sh docker <code_dir>" >&2
    19    exit 2
    20  }
    21
    22  tf_resources() {
    23    terraform -chdir="$1/terraform/envs/$2" show -json \
    24      | jq -c '.values.root_module // {} | .. | objects | select(has("type") and has("values"))'
    25  }
    26
    27  hosts_mode() {
    28    local env="$1" code="$2" h img
    29    : "${VAULT_ID:?VAULT_ID is required}"
    30    (cd "$code/ansible" && ANSIBLE_STDOUT_CALLBACK=ansible.posix.json \
    31      ansible-playbook -i "inventories/$env" site.yml --check --vault-id "$VAULT_ID") > "$tmp/check.json"
    32    jq -r '.plays[].tasks[] | .hosts | to_entries[] | select(.value.dest or .value.path) | "\(.key)\t\(.value.dest // .value.path)"' "$tmp/check.json" > "$tmp/managed.tsv"
    33    tf_resources "$code" "$env" \
    34      | jq -r 'select(.type == "docker_container") | .values.name as $n | .values.upload[]?.file | "\($n)\t\(.)"' >> "$tmp/managed.tsv"
    35    for h in $(jq -r '.stats | keys[]' "$tmp/check.json"); do
    36      img=$(docker inspect -f '{{.Image}}' "$h")
    37      docker run --rm --entrypoint dpkg-query "$img" -W -f '${Package}\n' | sort > "$tmp/pkg-image"
    38      docker exec "$h" dpkg-query -W -f '${Package}\n' | sort > "$tmp/pkg-host"
    39      comm -13 "$tmp/pkg-image" "$tmp/pkg-host" | awk -v e="$env" -v h="$h" '{print "UNMANAGED", e, h, "package", $1, "added"}'
    40      comm -23 "$tmp/pkg-image" "$tmp/pkg-host" | awk -v e="$env" -v h="$h" '{print "UNMANAGED", e, h, "package", $1, "removed"}'
    41      docker run --rm --entrypoint find "$img" $SCAN_DIRS -type f -exec sha256sum {} + | awk '{print $2 "\t" $1}' | sort > "$tmp/file-image"
    42      docker exec "$h" find $SCAN_DIRS -type f -exec sha256sum {} + | awk '{print $2 "\t" $1}' | sort > "$tmp/file-host"
    43      join -t "$(printf '\t')" -a 1 -a 2 -e NONE -o 0,1.2,2.2 "$tmp/file-image" "$tmp/file-host" \
    44        | awk -F '\t' -v e="$env" -v h="$h" -v m="$tmp/managed.tsv" '
    45            BEGIN { while ((getline line < m) > 0) { split(line, f, "\t"); if (f[1] == h) managed[f[2]] = 1 } }
    46            $2 != $3 && !($1 in managed) {
    47              s = ($2 == "NONE") ? "added" : (($3 == "NONE") ? "removed" : "changed")
    48              print "UNMANAGED", e, h, "file", $1, s
    49            }'
    50    done
    51  }
    52
    53  docker_mode() {
    54    local code="$1" e k kind all known
    55    for e in dev stg prod; do tf_resources "$code" "$e"; done > "$tmp/tf.json"
    56    jq -r 'select(.type == "docker_container") | .values.id' "$tmp/tf.json" | sort -u > "$tmp/tf-containers"
    57    jq -r 'select(.type == "docker_image") | .values.image_id' "$tmp/tf.json" | sort -u > "$tmp/tf-images"
    58    jq -r 'select(.type == "docker_network") | .values.id' "$tmp/tf.json" | sort -u > "$tmp/tf-networks"
    59    docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}' | sort > "$tmp/containers"
    60    docker image ls --no-trunc --format '{{.ID}}\t{{.Repository}}:{{.Tag}}' | sort > "$tmp/images"
    61    docker network ls --no-trunc --format '{{.ID}}\t{{.Name}}' | sort > "$tmp/networks"
    62    for k in container:containers:tf-containers image:images:tf-images network:networks:tf-networks; do
    63      IFS=: read -r kind all known <<< "$k"
    64      awk -F '\t' -v k="$kind" -v known="$tmp/$known" '
    65        BEGIN { while ((getline id < known) > 0) seen[id] = 1 }
    66        !($1 in seen) { print "UNMANAGED", "-", "docker", k, $2, "untracked" }' "$tmp/$all"
    67    done
    68  }
    69
    70  [ $# -ge 1 ] || usage
    71  case "$1" in
    72    hosts)
    73      [ $# -eq 3 ] || usage
    74      case "$2" in
    75        dev|stg|prod) ;;
    76        *) usage ;;
    77      esac
    78      hosts_mode "$2" "$3" > "$tmp/out"
    79      ;;
    80    docker)
    81      [ $# -eq 2 ] || usage
    82      docker_mode "$2" > "$tmp/out"
    83      ;;
    84    *)
    85      usage
    86      ;;
    87  esac
    88  cat "$tmp/out"
    89  [ -s "$tmp/out" ] && exit 1
    90  exit 0
```

中身は、次のとおりです。

* 10〜11行目：途中のコマンドが失敗したら、終了コード2で止める。管理外がない（0）、ある（1）と、洗い出しの失敗（2）を分けるため。**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** のセクション3と同じく、失敗を「管理外なし」と取り違えないようにする
* 12行目：`sort`、`comm`、`join`の並び順をそろえる。最初は`C`にしていたが、Ansibleが`ERROR: Ansible requires the locale encoding to be UTF-8; Detected None.`で止まったため、UTF-8の`C.UTF-8`にした
* 13行目：比べるディレクトリ。既定は`/etc`
* 30〜32行目：確認モードの結果から、ホストごとに、Playbookが扱うパス（`dest`、`path`）を取り出す
* 33〜34行目：tfstateから、コンテナごとに、Terraformが置くパス（`upload`の`file`）を取り出す
* 37〜40行目：パッケージの一覧を、イメージと操作対象で比べる
* 41〜49行目：ファイルのハッシュ値を、イメージと操作対象で比べ、差のあったもののうち、記述にあるパスを差し引いて表示する。操作対象にだけあれば`added`、イメージにだけあれば`removed`、両方にあって中身が違えば`changed`
* 55〜67行目：3環境のtfstateに記録されたコンテナ、イメージ、ネットワークのIDを集め、Dockerの実際の一覧のうち、記録にないものを表示する

### ■ 検証内容：管理外のものを足す前に、洗い出す

手を加える前の状態で、洗い出しを動かしました。

**実行コマンド**

```plaintext
set -a; . ~/.config/tfstate-backend/backend.env; set +a
export VAULT_ID="gitops16@$HOME/.config/ansible-vault/gitops16-vault-pass"
for e in dev stg prod; do .github/scripts/find-unmanaged.sh hosts $e . 2> /tmp/s3-hosts-$e.err; echo "$e hosts_exit_code=$?"; done
.github/scripts/find-unmanaged.sh docker . 2> /tmp/s3-docker.err; echo "docker_exit_code=$?"
```

**▼ 実行結果**

```plaintext
UNMANAGED dev dev-node1 file /etc/hostname changed
UNMANAGED dev dev-node1 file /etc/hosts changed
UNMANAGED dev dev-node1 file /etc/passwd- changed
UNMANAGED dev dev-node1 file /etc/resolv.conf changed
UNMANAGED dev dev-node1 file /etc/shadow changed
UNMANAGED dev dev-node1 file /etc/shadow- changed
dev hosts_exit_code=1
（途中省略：stg-node1も同じ6行）
stg hosts_exit_code=1
（途中省略：target-node1〜3も、それぞれ同じ6行）
prod hosts_exit_code=1
UNMANAGED - docker container tfstate-pg untracked
UNMANAGED - docker image alpine:latest untracked
UNMANAGED - docker image ubuntu:22.04 untracked
UNMANAGED - docker image ansible-target:immutable untracked
UNMANAGED - docker image hello-world:latest untracked
UNMANAGED - docker image postgres:17 untracked
UNMANAGED - docker network none untracked
UNMANAGED - docker network host untracked
UNMANAGED - docker network bridge untracked
docker_exit_code=1
```

### ■ 結果

誰も手を加えていない状態でも、洗い出しは管理外の候補を出しました。

|候補|何か|
|---|---|
|5台の`/etc/hostname`、`/etc/hosts`、`/etc/resolv.conf`|コンテナの起動のたびにDockerが書くファイル|
|5台の`/etc/shadow`、`/etc/shadow-`、`/etc/passwd-`|Playbookのタスクがパスワードを設定したときに書き換わるファイル。タスクの`dest`や`path`には現れない|
|コンテナ`tfstate-pg`|tfstateを置いているPostgreSQL。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** で、Terraformの外で動かした|
|イメージ5つ|`tfstate-pg`の元の`postgres:17`のほか、どの環境のtfstateにも記録されていないイメージ|
|ネットワーク`bridge`、`host`、`none`|Dockerが最初から持っているネットワーク|

Playbookが置く2つのファイルと`/etc/init_marker`は、記述から取り出したパスで差し引かれ、出ていません。残った候補は、どれも出どころを説明できますが、どの記述にもありません。洗い出しは、記述にないものを見つける仕組みなので、説明できるかどうかは区別しません。これらをどう扱うかは、**[セクション4](#4-見つけたものを3つに振り分ける)** で扱います。

### ■ 検証内容：管理外のものを足す

prodのtarget-node1に、Playbookにないものを3つ手で足し、Terraformの外でコンテナを1つ作りました。

|足したもの|内容|
|---|---|
|パッケージ|`tree`を`apt-get`で入れる|
|新しいファイル|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** のセクション6と同じ形の`/etc/gitops21-manual.conf`を置く|
|イメージにあるファイルの書き換え|`/etc/bash.bashrc`の末尾に1行足す。**[ドリフトシリーズ第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-03/)** でcronジョブが書き換えたのと同じく、どのタスクにもないファイルの書き換え|
|Terraformの外のコンテナ|`alpine:latest`から、`gitops21-unmanaged`を動かしたまま作る。**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** のセクション3で、止まったコンテナに`plan`を実行するとコンテナが削除されたため、止めずに扱う|

**実行コマンド**

```plaintext
docker exec target-node1 sh -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends tree' > /tmp/s3-apt.log 2>&1; echo "apt_exit_code=$?"
docker exec target-node1 dpkg-query -W tree
docker exec target-node1 sh -c 'echo "emergency_workaround=enabled" > /etc/gitops21-manual.conf'
docker exec target-node1 sh -c 'echo "# gitops21: manual edit" >> /etc/bash.bashrc'
docker exec target-node1 ls -l /etc/gitops21-manual.conf
docker exec target-node1 tail -1 /etc/bash.bashrc
docker run -d --name gitops21-unmanaged alpine:latest sleep infinity
docker ps --filter name=gitops21-unmanaged --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

**▼ 実行結果**

```plaintext
apt_exit_code=0
tree    2.0.2-1
-rw-r--r-- 1 root root 29 Nov  2 00:43 /etc/gitops21-manual.conf
# gitops21: manual edit
cf3c2601f340b9376cec9fa13d6f4ee6ea479002b41e6c0bc285954d6f650bc9
NAMES                IMAGE           STATUS
gitops21-unmanaged   alpine:latest   Up Less than a second
```

### ■ 検証内容：洗い出しと、これまでの検知を並べる

同じ状態で、洗い出しと、`terraform plan`、確認モードを、手元で並べて実行しました。

**実行コマンド**

```plaintext
for e in dev stg prod; do .github/scripts/find-unmanaged.sh hosts $e . 2> /tmp/s3-hosts-$e.err; echo "$e hosts_exit_code=$?"; done
.github/scripts/find-unmanaged.sh docker . 2> /tmp/s3-docker.err; echo "docker_exit_code=$?"
for e in dev stg prod; do terraform -chdir=terraform/envs/$e plan -input=false -detailed-exitcode > /tmp/plan-$e.log 2>&1; rc=$?; echo "$e plan_exit_code=$rc"; [ $rc -ne 0 ] && grep -E '^  # |forces replacement|^Plan:|Error' /tmp/plan-$e.log; rm /tmp/plan-$e.log; done
cd ansible
for e in dev stg prod; do echo "== $e"; ansible-playbook -i inventories/$e site.yml --check --diff --vault-id "$VAULT_ID" 2>/dev/null | grep -E '^[+-][^+-]|: ok='; done
```

**▼ 実行結果**

```plaintext
（途中省略：devとstgは、手を加える前と同じ6行ずつ）
dev hosts_exit_code=1
stg hosts_exit_code=1
UNMANAGED prod target-node1 package tree added
UNMANAGED prod target-node1 file /etc/bash.bashrc changed
UNMANAGED prod target-node1 file /etc/gitops21-manual.conf added
UNMANAGED prod target-node1 file /etc/hostname changed
（途中省略：target-node1の残りの5行と、target-node2、target-node3の6行ずつは、手を加える前と同じ）
prod hosts_exit_code=1
UNMANAGED - docker container tfstate-pg untracked
UNMANAGED - docker container gitops21-unmanaged untracked
（途中省略：イメージ5つ、ネットワーク3つは、手を加える前と同じ）
docker_exit_code=1
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

続けて、パイプラインの検知でも同じかを確かめるため、「Drift Detect」を、`compare_with`を`last-applied`、`converge`を無効にして起動しました（「Drift Detect」の実行#49）。

**▼ 実行結果**（「Drift Detect」の実行#49、`detect`ジョブから抜粋）

```plaintext
  COMPARE_WITH: last-applied
  CONVERGE: false
（途中省略：環境変数の表示）
== dev
compare_with=last-applied ref=7223eb7eb800bcdebdd6f7441031e7a0cdc0c618
（途中省略：planは差分なし）
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（途中省略：stgも同じ）
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
== prod
compare_with=last-applied ref=7223eb7eb800bcdebdd6f7441031e7a0cdc0c618
（途中省略：planは差分なし）
{"target-node1":{"changed":0,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0},"target-node2":{"changed":0,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0},"target-node3":{"changed":0,"failures":0,"ignored":0,"ok":6,"rescued":0,"skipped":0,"unreachable":0}}
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（ステップ「Report to issues」）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
no open issue: [drift-detect] prod
```

### ■ 結果

足した4つに対する結果を並べると、次のとおりです。

|足したもの|洗い出し|`terraform plan`|確認モード|「Drift Detect」の実行#49|
|---|---|---|---|---|
|パッケージ`tree`|`package tree added`|差分なし|`changed=0`|`no_drift`|
|`/etc/gitops21-manual.conf`|`file … added`|差分なし|`changed=0`|`no_drift`|
|`/etc/bash.bashrc`の書き換え|`file … changed`|差分なし|`changed=0`|`no_drift`|
|コンテナ`gitops21-unmanaged`|`container … untracked`|差分なし|`changed=0`|`no_drift`|

洗い出しは、足した4つをすべて見つけました。一方で、`terraform plan`、確認モード、「Drift Detect」は、どれも差分なしと判定し、Issueも作られていません。**[セクション2](#2-検知も収束もできない乖離が残っている)** で整理したとおり、検知が比べるのは記述・記録されているものだけで、この4つはどれもその外にあります。Terraformの外で作ったコンテナも、コードにもtfstateにもないため、`plan`の比べる対象に入りませんでした。

洗い出しが見つけられたのは、比べる向きが逆だからです。検知は、記述・記録されているものから出発して、実際の状態を確かめます。洗い出しは、実際の状態から出発して、記述・記録されていないものを残します。

### ■ 検証内容：足したものを片付ける

足した4つを片付け、洗い出しを動かし直しました。

**実行コマンド**

```plaintext
docker exec target-node1 sh -c 'DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq tree' > /tmp/s3-apt-purge.log 2>&1; echo "purge_exit_code=$?"
docker exec target-node1 dpkg-query -W tree; echo "dpkg_query_exit_code=$?"
docker exec target-node1 rm /etc/gitops21-manual.conf
docker exec target-node1 sed -i '/^# gitops21: manual edit$/d' /etc/bash.bashrc
docker rm -f gitops21-unmanaged
docker exec target-node1 sh -c 'ls /var/lib/apt/lists | wc -l'
docker exec target-node2 sh -c 'ls /var/lib/apt/lists | wc -l'
.github/scripts/find-unmanaged.sh hosts prod . 2> /tmp/s3-hosts-prod.err; echo "prod hosts_exit_code=$?"
.github/scripts/find-unmanaged.sh docker . 2> /tmp/s3-docker.err; echo "docker_exit_code=$?"
```

**▼ 実行結果**

```plaintext
purge_exit_code=0
dpkg-query: no packages found matching tree
dpkg_query_exit_code=1
gitops21-unmanaged
21
0
UNMANAGED prod target-node1 file /etc/hostname changed
（途中省略：target-node1〜3の6行ずつ。手を加える前と同じ）
prod hosts_exit_code=1
（途中省略：手を加える前と同じ9行）
docker_exit_code=1
```

洗い出しの結果は、手を加える前と同じに戻りました。一方で、`/var/lib/apt/lists`には、target-node1にだけ21件が残っていました。`apt-get update`が取得したパッケージの一覧で、比べる範囲の`/etc`の外にあるため、洗い出しには現れません。手を加えていないtarget-node2と並べると、ほかにも違いがありました。

**実行コマンド**

```plaintext
docker exec target-node1 sh -c 'ls /var/lib/apt/lists | wc -l; ls /var/cache/apt/archives; ls -l /var/log/apt /var/log/dpkg.log 2>&1'
docker exec target-node2 sh -c 'ls /var/lib/apt/lists | wc -l; ls /var/cache/apt/archives; ls -l /var/log/apt /var/log/dpkg.log 2>&1'
```

**▼ 実行結果**

```plaintext
21
lock
partial
-rw-r--r-- 1 root root 240474 Nov  2 00:53 /var/log/dpkg.log

/var/log/apt:
total 68
-rw-r--r-- 1 root root  8328 Nov  2 00:53 eipp.log.xz
-rw-r--r-- 1 root root 24847 Nov  2 00:53 history.log
-rw-r----- 1 root adm  27979 Nov  2 00:53 term.log
0
lock
partial
-rw-r--r-- 1 root root 239496 Oct 20 05:05 /var/log/dpkg.log

/var/log/apt:
total 64
-rw-r--r-- 1 root root  8664 Oct 20 05:04 eipp.log.xz
-rw-r--r-- 1 root root 24555 Oct 20 05:05 history.log
-rw-r----- 1 root adm  26424 Oct 20 05:05 term.log
```

target-node1のパッケージの操作のログは、`tree`を入れて消した時刻に更新されていました。target-node2のログは、イメージを作ったときのままです。パッケージの一覧は`apt-get clean`と削除で片付けましたが、ログは操作の記録として残しています。

洗い出しが見るのは、決めた範囲の中だけです。範囲の外に残ったものは、洗い出しにも現れません。何を範囲に入れるかは、**[セクション7](#7-どこまで管理するかを決める)** で扱います。

### スクリプトをmainに入れる

洗い出しのスクリプトは、**[セクション4](#4-見つけたものを3つに振り分ける)** 以降でも使うため、プルリクエスト（PR#126）にしてmainに入れました。確認の実行（「GitOps Pipeline」の実行#204）でも、マージの実行（「GitOps Pipeline」の実行#205、マージコミット`1b97542`）でも、変更が`.github/scripts/`の下だけのため、`changes`ジョブだけが動き、承認待ちは作られていません。

次のセクションでは、洗い出しで見つけたものを、「取り込む」「削除する」「管理外と宣言する」の3つに振り分けます。

---

[↑ 目次に戻る](#-目次)

---

## 4. 見つけたものを3つに振り分ける

**[セクション3](#3-管理外のものを見つける)** の洗い出しで見つけたものを、「取り込む」「削除する」「管理外と宣言する」の3つに振り分け、どれを選んだかをGitに記録します。

### 3つの振り分け

見つけたものに対してできることは、次の3つです。

|振り分け|やること|Gitに残るもの|
|---|---|---|
|取り込む|Playbookのタスクか、Terraformのリソースとして書く|タスクやリソースの定義|
|削除する|「消す」と書いた変更を、前に進める形で適用する（**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**）|削除用のタスクや、定義を外したコミット|
|管理外と宣言する|管理しないと決めたものを、理由とともにリストに書く|宣言のリスト|

どれを選んでも、変更はプルリクエストにし、通常の経路（確認の実行、ガードレール、承認ゲート、dev→stg→prodの昇格）で適用します。手で消したり、手で取り込んだりはしません。手で片付けると、片付けたこと自体がGitに残らず、**[セクション2](#2-検知も収束もできない乖離が残っている)** の乖離を、別の形で作ることになるためです。

### ■ 検証内容：手を加えていない状態の候補を、管理外と宣言する

**[セクション3](#3-管理外のものを見つける)** で、手を加えていない状態でも出た候補を、管理外と宣言します。宣言には理由を書きます。理由を書けないものを宣言すると、「誰も理由が分からないまま残っているもの」を、リストに移しただけになるためです。そこで、候補ごとに、何に使われているかを確かめました。

確かめた結果、イメージとボリュームについて、次の事実が分かりました。

* `ubuntu:22.04`は、このリポジトリの`terraform/Dockerfile`の`FROM`に書かれていて、イメージを作るときの元になっている
* `ansible-target:immutable`は、同じDockerの上にある別のTerraformのプロジェクト（Ansible×Terraformシリーズの検証で使っていたもの）のtfstateに記録されている。そのtfstateには、prodのtfstateにも記録されている`ansible-target:ubuntu18.04`なども記録されていて、同じイメージを2つのtfstateが記録していた
* 同じ別のプロジェクトのtfstateには、ボリューム（`target-node1-data`）が記録されていた。**[セクション3](#3-管理外のものを見つける)** のスクリプトは、ボリュームを見ていなかった
* `tfstate-pg`は、ボリューム`tfstate-pg-data`をデータの置き場所として使っている

ボリュームは、コンテナを消しても残るデータの置き場所で、管理の外に残ると見落としやすい種類です。スクリプトに、ボリュームも比べる処理を足しました。あわせて、宣言のリストに載っているものを表示しない処理を足しました。

**▼ 実行結果**（`git diff .github/scripts/find-unmanaged.sh`）

```plaintext
@@ -4,13 +4,15 @@
 #       操作対象のパッケージとファイルを、イメージから作った直後の状態と比べ、
 #       Playbookが扱うパスと、Terraformがコンテナに置くパスを差し引いて表示する
 #   find-unmanaged.sh docker <コードのディレクトリ>
-#       Dockerのコンテナ・イメージ・ネットワークのうち、3環境のtfstateに記録がないものを表示する
+#       Dockerのコンテナ・イメージ・ネットワーク・ボリュームのうち、3環境のtfstateに記録がないものを表示する
+# 宣言リスト（既定は .github/unmanaged-declared.txt）に載っているものは表示しない
 # 出力       UNMANAGED <環境> <ホスト> <種類> <名前> <状態>
 # 終了コード 0=管理外なし、1=管理外あり、2=使い方の誤り・洗い出しの失敗
 set -Eeuo pipefail
 trap 'exit 2' ERR
 export LC_ALL=C.UTF-8
 SCAN_DIRS="${SCAN_DIRS:-/etc}"
+DECLARED="${DECLARED:-$(cd "$(dirname "$0")/.." && pwd)/unmanaged-declared.txt}"
 tmp=$(mktemp -d)
 trap 'rm -rf "$tmp"' EXIT

@@ -56,10 +58,12 @@ docker_mode() {
   jq -r 'select(.type == "docker_container") | .values.id' "$tmp/tf.json" | sort -u > "$tmp/tf-containers"
   jq -r 'select(.type == "docker_image") | .values.image_id' "$tmp/tf.json" | sort -u > "$tmp/tf-images"
   jq -r 'select(.type == "docker_network") | .values.id' "$tmp/tf.json" | sort -u > "$tmp/tf-networks"
+  jq -r 'select(.type == "docker_volume") | .values.id' "$tmp/tf.json" | sort -u > "$tmp/tf-volumes"
   docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}' | sort > "$tmp/containers"
   docker image ls --no-trunc --format '{{.ID}}\t{{.Repository}}:{{.Tag}}' | sort > "$tmp/images"
   docker network ls --no-trunc --format '{{.ID}}\t{{.Name}}' | sort > "$tmp/networks"
-  for k in container:containers:tf-containers image:images:tf-images network:networks:tf-networks; do
+  docker volume ls --format '{{.Name}}\t{{.Name}}' | sort > "$tmp/volumes"
+  for k in container:containers:tf-containers image:images:tf-images network:networks:tf-networks volume:volumes:tf-volumes; do
     IFS=: read -r kind all known <<< "$k"
     awk -F '\t' -v k="$kind" -v known="$tmp/$known" '
       BEGIN { while ((getline id < known) > 0) seen[id] = 1 }
@@ -85,6 +89,11 @@ case "$1" in
     usage
     ;;
 esac
-cat "$tmp/out"
-[ -s "$tmp/out" ] && exit 1
+awk 'FNR == NR { if ($0 !~ /^#/ && NF >= 4) { n++; e[n] = $1; h[n] = $2; k[n] = $3; m[n] = $4 }; next }
+  { hit = 0
+    for (i = 1; i <= n; i++) if ((e[i] == "*" || e[i] == $2) && (h[i] == "*" || h[i] == $3) && k[i] == $4 && m[i] == $5) { hit = 1; break }
+    if (hit) d++; else print }
+  END { print "declared: " d + 0 > "/dev/stderr" }' "$DECLARED" "$tmp/out" > "$tmp/undeclared"
+cat "$tmp/undeclared"
+[ -s "$tmp/undeclared" ] && exit 1
 exit 0
```

宣言のリストは、スクリプトと同じリポジトリの`.github/unmanaged-declared.txt`から読みます。**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の検知は、比べるコードを最後に適用したコミットから取り出し、検知の道具はmainの側を使っています。宣言のリストは`.github/`の下にあり、変えても「GitOps Apply」の適用は起きないため、最後に適用したコミットには入りません。そこで、検知の道具と同じく、mainの側から読む形にしました。外した件数は、`declared: N`としてエラー出力に出し、宣言で隠れたものの数が分かるようにしています。

宣言のリストは、次のとおりです。

**▼ 実行結果**（`cat .github/unmanaged-declared.txt`）

```plaintext
# 管理外と宣言したもの（.github/scripts/find-unmanaged.sh が読む）
# 書式：環境 ホスト 種類 名前 理由（空白で区切る。環境とホストの * は全体を指す）
* * file /etc/hostname コンテナの起動のたびにDockerが書く
* * file /etc/hosts コンテナの起動のたびにDockerが書く
* * file /etc/resolv.conf コンテナの起動のたびにDockerが書く
* * file /etc/shadow Playbookがユーザーansibleのパスワードを設定するときに書き換わる
* * file /etc/shadow- /etc/shadowのバックアップ
* * file /etc/passwd- /etc/passwdのバックアップ（ユーザーの設定のときに書き換わる）
- docker container tfstate-pg tfstateを置くPostgreSQL。Terraformの外で動かしている
- docker image postgres:17 tfstate-pgの元のイメージ
- docker volume tfstate-pg-data tfstate-pgのデータ
- docker image ubuntu:22.04 terraform/DockerfileのFROM。イメージを作るときの元
- docker image ansible-target:immutable 別のTerraformのプロジェクトのtfstateに記録されている
- docker volume target-node1-data 別のTerraformのプロジェクトのtfstateに記録されている
- docker image alpine:latest 一時的なコンテナの元
- docker image hello-world:latest Dockerの動作確認用
- docker network bridge Dockerが最初から持っている
- docker network host Dockerが最初から持っている
- docker network none Dockerが最初から持っている
```

この2つのファイルの変更をプルリクエスト（PR#127）にし、確認の実行（「GitOps Pipeline」の実行#206）とマージの実行（「GitOps Pipeline」の実行#207）で`changes`ジョブだけが動いたことを確かめて、マージしました（マージコミット`0e4604f`）。宣言をmainに入れた後に、洗い出しを動かしました。

**▼ 実行結果**

```plaintext
declared: 6
dev hosts_exit_code=0
declared: 6
stg hosts_exit_code=0
declared: 18
prod hosts_exit_code=0
declared: 11
docker_exit_code=0
```

### ■ 結果

宣言した17行で、手を加えていない状態の候補は、すべて理由とともに説明されました。洗い出しは、`UNMANAGED`の行を1つも出さず、終了コードは0（管理外なし）になりました。

宣言のリストには、もう1つの役割があります。`ansible-target:immutable`のように、別のプロジェクトのtfstateに記録されているものは、このパイプラインの3環境から見れば管理外です。どのtfstateと突き合わせるかによって、管理外かどうかは変わります。宣言のリストは、「このパイプラインが、何を自分の範囲の外と決めたか」の記録にもなります。

### ■ 検証内容：新しく管理外のものを作る

宣言した後に、新しく管理外のものを作り、「取り込む」と「削除する」に振り分けます。

|作るもの|振り分け|
|---|---|
|dev-node1の`/etc/gitops21-keep.conf`|取り込む（Playbookに`copy`のタスクを書く）|
|dev-node1の`/etc/gitops21-drop.conf`|削除する（Playbookに`state: absent`のタスクを書く）|
|Terraformの外で作るコンテナ`gitops21-import`（`alpine:latest`）|取り込む（devのTerraformのコードに書く）|

**実行コマンド**

```plaintext
docker exec dev-node1 sh -c 'echo "kept_by=gitops21" > /etc/gitops21-keep.conf'
docker exec dev-node1 sh -c 'echo "dropped_by=gitops21" > /etc/gitops21-drop.conf'
docker run -d --name gitops21-import alpine:latest sleep infinity
.github/scripts/find-unmanaged.sh hosts dev . 2>&1; echo "dev hosts_exit_code=$?"
.github/scripts/find-unmanaged.sh docker . 2>&1; echo "docker_exit_code=$?"
```

**▼ 実行結果**

```plaintext
4fec1c559af25c1fd38e6c15c5408880619c6855a972f3c4eeb681906802b3ef
declared: 6
UNMANAGED dev dev-node1 file /etc/gitops21-drop.conf added
UNMANAGED dev dev-node1 file /etc/gitops21-keep.conf added
dev hosts_exit_code=1
declared: 11
UNMANAGED - docker container gitops21-import untracked
docker_exit_code=1
```

宣言したものは出ず、新しく作った3つだけが出ました。

### ■ 検証内容：Ansibleの側を、取り込む・削除するに振り分ける

ロール`common_setup`に、取り込む`copy`のタスクと、削除する`state: absent`のタスクを書いたファイルを足し、`tasks/main.yml`から読み込みます。`keep.conf`は、dev-node1にある内容と権限のとおりに書きます。

* **ファイル名：`ansible/roles/common_setup/tasks/gitops21_sort.yml`（新規作成）**

```yaml
---
- name: 洗い出しで見つけたファイルを取り込む
  become: true
  ansible.builtin.copy:
    dest: /etc/gitops21-keep.conf
    content: "kept_by=gitops21\n"
    mode: "0644"
- name: 洗い出しで見つけたファイルを削除する
  become: true
  ansible.builtin.file:
    path: /etc/gitops21-drop.conf
    state: absent
```

* **ファイル名：`ansible/roles/common_setup/tasks/main.yml`（追加した2行）**

```yaml
- name: 洗い出しの振り分けのタスクを読み込み
  ansible.builtin.import_tasks: gitops21_sort.yml
```

この変更をプルリクエスト（PR#128）にしました。確認の実行（「GitOps Pipeline」の実行#208）では、`ansible-lint`、`molecule`、`ansible-check`が成功しています。マージし（マージコミット`23834d3`、「GitOps Pipeline」の実行#209）、「GitOps Apply」でdev（「GitOps Apply」の実行#122）、stg（「GitOps Apply」の実行#123）、prod（「GitOps Apply」の実行#124）の順に適用しました。

**▼ 実行結果**（「GitOps Apply」の実行#122、`ansible-apply`ジョブから抜粋）

```plaintext
TASK [common_setup : 洗い出しで見つけたファイルを取り込む] *********************
ok: [dev-node1]

TASK [common_setup : 洗い出しで見つけたファイルを削除する] *********************
--- before
+++ after
@@ -1,4 +1,4 @@
 {
     "path": "/etc/gitops21-drop.conf",
-    "state": "file"
+    "state": "absent"
 }

changed: [dev-node1]
（途中省略）
dev-node1                  : ok=8    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**▼ 実行結果**（「GitOps Apply」の実行#123、`ansible-apply`ジョブから抜粋）

```plaintext
TASK [common_setup : 洗い出しで見つけたファイルを取り込む] *********************
--- before
+++ after: /etc/gitops21-keep.conf
@@ -0,0 +1 @@
+kept_by=gitops21

changed: [stg-node1]

TASK [common_setup : 洗い出しで見つけたファイルを削除する] *********************
ok: [stg-node1]
（途中省略）
stg-node1                  : ok=8    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

prod（「GitOps Apply」の実行#124）も、stgと同じく、target-node1〜3に`keep.conf`が置かれて`changed=1`でした。dev-node1では、取り込んだ`keep.conf`は手で置いた内容と一致していたため`ok`で、`drop.conf`だけが消えています。dev以外の4台では、`keep.conf`が新しく置かれました。取り込むことは、見つけたホストの状態を記述するだけでなく、ほかのホストにも同じ状態を届けることになります。

### ■ 検証内容：Terraformの側を、取り込む

コンテナ`gitops21-import`を、devのTerraformのコードに取り込みます。Terraformの`import`ブロックを書くと、取り込みも`plan`に現れ、プルリクエストと承認ゲートを通して適用できます。`terraform import`のコマンドを手元で実行すると、tfstateだけが先に変わり、コードとの食い違いが生まれるため、この形をとります。

まず、`import`ブロックだけを書き、`plan`の`-generate-config-out`で、実物の属性からリソースの定義を書き出させました。

**▼ 実行結果**（`terraform plan -generate-config-out=gitops21_generated.tf`から抜粋）

```plaintext
  # docker_container.gitops21_import must be replaced
  # (imported from "4fec1c559af25c1fd38e6c15c5408880619c6855a972f3c4eeb681906802b3ef")
  # Warning: this will destroy the imported resource
（途中省略）
      + env                                         = (known after apply) # forces replacement
（途中省略）
Plan: 1 to import, 1 to add, 0 to change, 1 to destroy.
```

Terraformが実物から書き出した定義でも、そのままでは取り込みにならず、「取り込んだうえで作り直す」計画になりました。原因は`env`です。書き出された定義に`env`はなく、実物から作り直す差として計画されています。

書き出された55行の定義は使わず、名前、イメージ、コマンドだけの定義を書き、実物と同じ`env`も書きました。それでも、計画は作り直しのままでした。

**▼ 実行結果**（`env`を書いた定義での`plan`から抜粋）

```plaintext
  # docker_container.gitops21_import must be replaced
（途中省略）
      + env                                         = [ # forces replacement
      - network_mode                                = "bridge" -> null # forces replacement
Plan: 1 to import, 1 to add, 0 to change, 1 to destroy.
```

`env`は、取り込んだときのtfstateに入らないため、定義に書いても書かなくても、作り直しの計画になりました。`network_mode`は、定義に書かなかったため、実物の`bridge`を外す変更とみなされました。

`network_mode`は定義に書き、`env`は`lifecycle`の`ignore_changes`で、比べる対象から外しました。

* **ファイル名：`terraform/envs/dev/gitops21_import.tf`（新規作成）**

```hcl
import {
  to = docker_container.gitops21_import
  id = "4fec1c559af25c1fd38e6c15c5408880619c6855a972f3c4eeb681906802b3ef"
}

resource "docker_container" "gitops21_import" {
  name         = "gitops21-import"
  image        = "sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b"
  command      = ["sleep", "infinity"]
  network_mode = "bridge"
  lifecycle {
    # 取り込んだときのtfstateにenvが入らず、書いても書かなくても作り直しの計画になるため、比べない
    ignore_changes = [env]
  }
}
```

この定義で、計画は`Plan: 1 to import, 0 to add, 1 to change, 0 to destroy.`になりました。その場の更新で`+`になるのは、`must_run`、`start`、`logs`、`wait`などの、プロバイダーがコンテナを扱うときの振る舞いを決める値で、取り込みの時点では実物から読めないため、初期値で埋まるものです。コンテナの名前、イメージ、コマンド、ネットワークには差がありません。

この変更をプルリクエスト（PR#129）にし、マージしました（マージコミット`f371828`、「GitOps Pipeline」の実行#210・#211）。「GitOps Apply」でdev（「GitOps Apply」の実行#125）、stg（「GitOps Apply」の実行#126）、prod（「GitOps Apply」の実行#127）の順に適用しました。

**▼ 実行結果**（「GitOps Apply」の実行#125、`verify`ジョブのステップ「Check plan policy」から抜粋）

```plaintext
2418804b8fa2153a7c992c6d7b491c4fbaafb2a77fbd63930e2f5803328f81a4  /home/control/gitops-pending/dev/tfplan
PASS  docker_container.gitops21_import actions=update
policy: pass
```

**▼ 実行結果**（「GitOps Apply」の実行#125、`terraform-apply`ジョブから抜粋）

```plaintext
2418804b8fa2153a7c992c6d7b491c4fbaafb2a77fbd63930e2f5803328f81a4  /home/control/gitops-pending/dev/tfplan
docker_container.gitops21_import: Importing... [id=4fec1c559af25c1fd38e6c15c5408880619c6855a972f3c4eeb681906802b3ef]
docker_container.gitops21_import: Import complete [id=4fec1c559af25c1fd38e6c15c5408880619c6855a972f3c4eeb681906802b3ef]
docker_container.gitops21_import: Modifying... [id=4fec1c559af25c1fd38e6c15c5408880619c6855a972f3c4eeb681906802b3ef]
docker_container.gitops21_import: Modifications complete after 0s [id=4fec1c559af25c1fd38e6c15c5408880619c6855a972f3c4eeb681906802b3ef]

Apply complete! Resources: 1 imported, 0 added, 1 changed, 0 destroyed.
```

**▼ 実行結果**（適用の後、手元で確かめた結果）

```plaintext
/gitops21-import id=4fec1c559af2 status=running started=2026-11-02T01:26:43.791217117Z
docker_container.gitops21_import
module.lab_env.docker_container.targets["dev-node1"]
module.lab_env.docker_image.this
module.lab_env.docker_network.this
module.lab_env.terraform_data.gitops18_pending
dev plan_exit_code=0
```

コンテナのIDと起動の時刻は、作ったときのままで、作り直されていません。devのtfstateに`docker_container.gitops21_import`が加わり、devの`plan`は差分なしです。stgとprodの適用は、コードが変わっていないため、`0 added, 0 changed, 0 destroyed`でした。

### ■ 検証内容：振り分けた後に、洗い出す

**▼ 実行結果**

```plaintext
declared: 6
dev hosts_exit_code=0
declared: 6
stg hosts_exit_code=0
declared: 18
prod hosts_exit_code=0
declared: 11
docker_exit_code=0
```

### ■ 結果

振り分けた3つの結果を並べます。

|見つけたもの|振り分け|Gitに残ったもの|適用の結果|洗い出し|
|---|---|---|---|---|
|`/etc/gitops21-keep.conf`|取り込む|`copy`のタスク（PR#128）|dev-node1は`ok`、ほかの4台に新しく置かれた|Playbookが扱うパスとして差し引かれ、出ない|
|`/etc/gitops21-drop.conf`|削除する|`state: absent`のタスク（PR#128）|dev-node1から消えた|ファイルがなく、出ない|
|コンテナ`gitops21-import`|取り込む|`import`ブロックとリソースの定義（PR#129）|作り直されずに、devのtfstateに記録された|tfstateに記録があり、出ない|
|手を加えていない状態の候補（17行）|管理外と宣言する|宣言のリスト（PR#127）|適用なし|宣言のリストで外され、出ない|

洗い出しが何も出さなくなったのは、管理外のものが実環境から消えたからではありません。`keep.conf`もコンテナも、実環境に残っています。変わったのは、Gitの側です。取り込んだものはタスクとリソースの定義に、削除したものは削除用タスクのコミットに、管理外としたものは理由とともに宣言のリストに、それぞれ記録されています。**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** の「記述・記録されていないものは見えない」の、記述・記録されていない側が、なくなりました。

一方で、Terraformの外で作ったものを取り込むと、プロバイダーが読み戻せない属性（この回では`env`）を`ignore_changes`で外す必要がありました。取り込みは、検知の範囲を広げると同時に、意図して見ない属性を1つ増やしています。`ignore_changes`の見直しは、**[セクション6](#6-意図的に外した属性と削除用タスクを見直す)** で扱います。

### 検証の後片付け

このセクションで入れたタスクとリソースは、同じく通常の経路で片付けました。

* PR#130：`keep.conf`のタスクを`state: absent`に書き換え、コンテナの定義をdevのコードから外した。devの適用（「GitOps Apply」の実行#128）では、`plan-policy.sh`がコンテナの削除を`BLOCK`と判定し、devのため警告で通り、コンテナが削除された（`1 destroyed`）。stg、prodも適用した（「GitOps Apply」の実行#129・#130）
* PR#131：3環境とも、最後に適用したコミットが削除用タスクを含むコミット（`6ba6949`）になったことを`gitops.applied`で確かめてから、2つの削除用タスクを外した。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** のセクション7の基準どおり。3環境に適用した（「GitOps Apply」の実行#131〜#133）

片付けの後、`ansible/`と`terraform/`の下は、この回の検証を始める前のコミット（`7223eb7`）と同じになり、3環境の`plan`は差分なし、洗い出しは管理外なしです。mainに残ったのは、洗い出しのスクリプトと宣言のリストだけです。

次のセクションでは、この洗い出しを、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の定期検知と並べて、定期的に動かします。

---

[↑ 目次に戻る](#-目次)

---

## 5. 定期的な洗い出しと検知を並べる

**[セクション3](#3-管理外のものを見つける)** の洗い出しを、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の定期検知と並べて、定期的に動かします。

### 洗い出しも、一度きりでは終わらない

**[セクション4](#4-見つけたものを3つに振り分ける)** で、手を加えていない状態の候補を宣言し、管理外がない状態を作りました。ただし、これはその時点の状態です。手動変更、別の仕組みによる書き換え、Terraformの外でのリソースの作成は、この後も起こります。**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** で検知を定期的に動かしたのと同じく、洗い出しも定期的に動かさなければ、新しく現れた管理外のものには気づけません。

洗い出しは、新しいワークフロー「Unmanaged Detect」として作りました。「Drift Detect」には、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** の収束と、**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** の一時停止の確認が入っています。そこに洗い出しを足すより、別のワークフローに分けたほうが、変更の範囲がはっきりするためです。仕組みは「Drift Detect」とそろえ、違うのは、比べ方と結果の扱いだけにしました。

|項目|「Drift Detect」|「Unmanaged Detect」|
|---|---|---|
|比べるもの|最後に適用したコミットのコードと、実環境の差（記述・記録されているものの中）|実環境のうち、記述・記録にも宣言にもないもの|
|比べるコード|環境ごとに最後に適用したコミット|同じ。Dockerのリソースは、3環境のtfstateを読む|
|結果の分け方|差分なし・差分あり・検知失敗|なし（`none`）・あり（`found`）・洗い出しの失敗（`find_failed`）|
|見つけたときの扱い|収束を有効にしていれば、自動で戻す|戻さない。Issueに残して、人に返す|
|Issue|`[drift-detect] <環境>`|`[unmanaged] <環境>`、`[unmanaged] docker`|
|スケジュール|毎日6:17（日本時間）|毎日6:32（日本時間）|
|同時実行のグループ|`gitops-pipeline`|`gitops-pipeline`|

見つけたものを自動で戻さないのは、**[セクション4](#4-見つけたものを3つに振り分ける)** の3つの振り分けのどれを選ぶかは、見つけたものが何かによって変わるためです。消してよいものか、取り込むべきものか、宣言すべきものかは、洗い出しの結果だけからは決められません。**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)** で、作り直しや削除を含む変更を人に返したのと同じ扱いです。

### ■ 検証内容：洗い出しのワークフローを作る

**▼ 実行結果**（`cat -n .github/workflows/unmanaged-detect.yml`）

```plaintext
     1  name: Unmanaged Detect
     2
     3  on:
     4    schedule:
     5      - cron: '32 21 * * *'
     6    workflow_dispatch:
     7
     8  concurrency:
     9    group: gitops-pipeline
    10    queue: max
    11
    12  permissions:
    13    contents: read
    14    issues: write
    15
    16  jobs:
    17    find:
    18      runs-on: [self-hosted, Linux, X64]
    19      steps:
    20        - name: Check branch
    21          run: |
    22            echo "ref=$GITHUB_REF sha=$GITHUB_SHA"
    23            if [ "$GITHUB_REF" != "refs/heads/main" ]; then
    24              echo "::error::not started from main"
    25              exit 1
    26            fi
    27        - uses: actions/checkout@v4
    28          with:
    29            fetch-depth: 0
    30        - name: Add Ansible to PATH
    31          run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
    32        - name: Write private keys from secrets
    33          env:
    34            CONNECT_PRIVATE_KEY_DEV: ${{ secrets.CONNECT_PRIVATE_KEY_DEV }}
    35            CONNECT_PRIVATE_KEY_STG: ${{ secrets.CONNECT_PRIVATE_KEY_STG }}
    36            CONNECT_PRIVATE_KEY_PROD: ${{ secrets.CONNECT_PRIVATE_KEY_PROD }}
    37          run: |
    38            umask 077
    39            mkdir -p "$RUNNER_TEMP/keys/dev" "$RUNNER_TEMP/keys/stg" "$RUNNER_TEMP/keys/prod"
    40            printf '%s\n' "$CONNECT_PRIVATE_KEY_DEV" > "$RUNNER_TEMP/keys/dev/id_ed25519"
    41            printf '%s\n' "$CONNECT_PRIVATE_KEY_STG" > "$RUNNER_TEMP/keys/stg/id_ed25519"
    42            printf '%s\n' "$CONNECT_PRIVATE_KEY_PROD" > "$RUNNER_TEMP/keys/prod/id_ed25519"
    43        - name: Find unmanaged
    44          env:
    45            PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
    46            TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
    47            ANSIBLE_VAULT_PASSWORD_GITOPS16: ${{ secrets.ANSIBLE_VAULT_PASSWORD_GITOPS16 }}
    48            GITOPS_KEY_DIR: ${{ runner.temp }}/keys
    49          run: |
    50            export VAULT_ID="gitops16@$GITHUB_WORKSPACE/.github/scripts/vault-pass-client.sh"
    51            failed=0
    52            for t in dev stg prod docker; do
    53              echo "== $t"
    54              rc=0
    55              out="$RUNNER_TEMP/unmanaged-$t.txt"
    56              : > "$out"
    57              if [ "$t" = "docker" ]; then
    58                ref="$GITHUB_SHA"
    59                for e in dev stg prod; do
    60                  terraform -chdir="terraform/envs/$e" init -input=false -lockfile=readonly > /dev/null || rc=2
    61                done
    62                if [ "$rc" -eq 0 ]; then
    63                  .github/scripts/find-unmanaged.sh docker "$GITHUB_WORKSPACE" > "$out" || rc=$?
    64                fi
    65              else
    66                ref=$(.github/scripts/applied.sh last "$t") || ref=""
    67                wt="$RUNNER_TEMP/unmanaged-$t"
    68                if [ -n "$ref" ] && git worktree add --detach "$wt" "$ref" > /dev/null \
    69                  && terraform -chdir="$wt/terraform/envs/$t" init -input=false -lockfile=readonly > /dev/null; then
    70                  .github/scripts/find-unmanaged.sh hosts "$t" "$wt" > "$out" || rc=$?
    71                else
    72                  rc=2
    73                fi
    74              fi
    75              cat "$out"
    76              case "$rc" in
    77                0) result=none ;;
    78                1) result=found ;;
    79                *) result=find_failed; failed=1 ;;
    80              esac
    81              echo "RESULT $t=$result exit_code=$rc ref=${ref:-（取得できず）}"
    82              printf '%s\n' "$result" > "$RUNNER_TEMP/unmanaged-result-$t"
    83              {
    84                echo "- 結果: $result"
    85                echo "- 比べたコミット: ${ref:-（取得できず）}"
    86                echo "- 終了コード: $rc"
    87                echo "- 実行: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
    88                echo "- 時刻: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    89                if [ -s "$out" ]; then
    90                  echo
    91                  sed 's/^/- /' "$out"
    92                fi
    93              } > "$RUNNER_TEMP/unmanaged-report-$t.md"
    94            done
    95            exit $failed
    96        - name: Report to issues
    97          if: always()
    98          env:
    99            GH_TOKEN: ${{ github.token }}
   100          run: |
   101            for t in dev stg prod docker; do
   102              if [ ! -f "$RUNNER_TEMP/unmanaged-result-$t" ]; then
   103                echo "$t: no result"
   104                continue
   105              fi
   106              if [ "$(cat "$RUNNER_TEMP/unmanaged-result-$t")" = "none" ]; then
   107                action=close
   108              else
   109                action=open
   110              fi
   111              .github/scripts/report-issue.sh "[unmanaged] $t" "$action" "$RUNNER_TEMP/unmanaged-report-$t.md"
   112            done
   113        - name: Clean up
   114          if: always()
   115          run: |
   116            rm -rf "$RUNNER_TEMP/keys" "$RUNNER_TEMP"/unmanaged-*
   117            git worktree prune
```

「Drift Detect」と同じ部分（ブランチの確認、秘密鍵の書き出し、同時実行のグループ）を除くと、中身は次のとおりです。

* 5行目：毎日21:32（UTC）、日本時間の6:32に動く。「Drift Detect」の15分後で、同じグループのため、重なっても順に動く
* 66〜73行目：dev、stg、prodは、最後に適用したコミットのコードを取り出して、`find-unmanaged.sh hosts`に渡す。スクリプトと宣言のリストは、mainの側を使う
* 57〜64行目：Dockerのリソースは、3環境のtfstateを読むだけなので、mainのコードで初期化して`find-unmanaged.sh docker`を動かす
* 76〜80行目：スクリプトの終了コードで、`none`・`found`・`find_failed`に分ける。`find_failed`があればジョブを失敗にする。`found`ではジョブを失敗にしない。**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** のセクション3で、差分ありをジョブの失敗にしなかったのと同じ扱い
* 83〜93行目：Issueの本文に、結果、比べたコミット、終了コード、実行のURL、時刻と、見つけたものを1行ずつ書く
* 96〜112行目：**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** のセクション6の`report-issue.sh`で、`none`ならIssueを閉じ、それ以外なら開くか、本文を書き換える

この変更をプルリクエスト（PR#132）にし、確認の実行（「GitOps Pipeline」の実行#216）とマージの実行（「GitOps Pipeline」の実行#217）で`changes`ジョブだけが動いたことを確かめて、マージしました（マージコミット`cbf7cca`）。

### ■ 検証内容：管理外がない状態で、洗い出す

「Unmanaged Detect」を手動で起動しました（「Unmanaged Detect」の実行#1）。

**▼ 実行結果**（「Unmanaged Detect」の実行#1、`find`ジョブから抜粋）

```plaintext
== dev
declared: 6
RESULT dev=none exit_code=0 ref=ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
== stg
declared: 6
RESULT stg=none exit_code=0 ref=ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
== prod
declared: 18
RESULT prod=none exit_code=0 ref=ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
== docker
declared: 11
RESULT docker=none exit_code=0 ref=cbf7ccaf7ddcd3e37d54f0e472dcca51685ce369
（ステップ「Report to issues」）
no open issue: [unmanaged] dev
no open issue: [unmanaged] stg
no open issue: [unmanaged] prod
no open issue: [unmanaged] docker
```

4つとも`none`で、Issueは作られていません。宣言したものは、`declared:`の件数として数えられたうえで、結果から外れています。

### ■ 検証内容：管理外のものを足して、洗い出す

stg-node1にファイルを1つ手で置き、Terraformの外でコンテナを1つ作りました。

**実行コマンド**

```plaintext
docker exec stg-node1 sh -c 'echo "added_by=gitops21-scheduled-check" > /etc/gitops21-sched.conf'
docker run -d --name gitops21-sched alpine:latest sleep infinity
```

「Unmanaged Detect」を起動しました（「Unmanaged Detect」の実行#2）。

**▼ 実行結果**（「Unmanaged Detect」の実行#2、`find`ジョブから抜粋）

```plaintext
== dev
declared: 6
RESULT dev=none exit_code=0 ref=ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
== stg
declared: 6
UNMANAGED stg stg-node1 file /etc/gitops21-sched.conf added
RESULT stg=found exit_code=1 ref=ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
== prod
declared: 18
RESULT prod=none exit_code=0 ref=ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
== docker
declared: 11
UNMANAGED - docker container gitops21-sched untracked
RESULT docker=found exit_code=1 ref=cbf7ccaf7ddcd3e37d54f0e472dcca51685ce369
（ステップ「Report to issues」）
no open issue: [unmanaged] dev
issue #133 created: [unmanaged] stg
no open issue: [unmanaged] prod
issue #134 created: [unmanaged] docker
```

**▼ 実行結果**（Issue#133の本文）

```plaintext
- 結果: found
- 比べたコミット: ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
- 終了コード: 1
- 実行: https://github.com/juehara-crypto/ansible-terraform-ci-lab/actions/runs/41395318102
- 時刻: 2026-11-02T05:41:07Z

- UNMANAGED stg stg-node1 file /etc/gitops21-sched.conf added
```

同じ状態で、「Drift Detect」を、`compare_with`を`last-applied`、`converge`を無効にして起動しました（「Drift Detect」の実行#50）。

**▼ 実行結果**（「Drift Detect」の実行#50、`detect`ジョブから抜粋）

```plaintext
RESULT dev=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT stg=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
RESULT prod=no_drift plan_exit_code=0 check_exit_code=0 changed=0 failed_hosts=0
（ステップ「Report to issues」）
no open issue: [drift-detect] dev
no open issue: [drift-detect] stg
no open issue: [drift-detect] prod
```

### ■ 結果

同じ時点の、2つのワークフローの結果を並べます。

|ワークフロー|stgの`/etc/gitops21-sched.conf`|コンテナ`gitops21-sched`|Issue|
|---|---|---|---|
|「Drift Detect」の実行#50|`no_drift`（現れない）|比べる対象にない|作られない|
|「Unmanaged Detect」の実行#2|`found`|`found`|Issue#133、Issue#134が作られた|

「Drift Detect」だけを毎日動かしていれば、この2つは、どのIssueにも現れないまま残っていました。2つのワークフローを並べて動かすことで、記述・記録されているものの中のずれは「Drift Detect」が、その外にあるものは「Unmanaged Detect」が、それぞれIssueに残します。

### ■ 検証内容：片付けて、洗い出す

足したファイルとコンテナを手で片付け、「Unmanaged Detect」を起動しました（「Unmanaged Detect」の実行#3）。

**▼ 実行結果**（「Unmanaged Detect」の実行#3、`find`ジョブから抜粋）

```plaintext
RESULT dev=none exit_code=0 ref=ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
RESULT stg=none exit_code=0 ref=ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
RESULT prod=none exit_code=0 ref=ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
RESULT docker=none exit_code=0 ref=cbf7ccaf7ddcd3e37d54f0e472dcca51685ce369
（ステップ「Report to issues」）
no open issue: [unmanaged] dev
issue #133 closed: [unmanaged] stg
no open issue: [unmanaged] prod
issue #134 closed: [unmanaged] docker
```

### ■ 結果

管理外のものがなくなると、開いていたIssueは「解消しました。」のコメントとともに閉じられました。**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の検知のIssueと同じく、開いているIssueを見れば、今、管理外のものがどこにあるかが分かります。

この検証では、見つけたものを手で片付けました。本来は、Issueを見た人が、**[セクション4](#4-見つけたものを3つに振り分ける)** の3つのどれかを選び、プルリクエストとして通常の経路で適用します。洗い出しのワークフローは、振り分けが必要なものがあることを知らせるところまでを受け持ちます。

### 定期的な洗い出しでも残るもの

この形でも、次のものは残ります。

* **確認役の対象外**：**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の確認役「Drift Detect Watch」が読むのは、「Drift Detect」の実行だけです。「Unmanaged Detect」が止まっても、確認役は気づきません。同じ確認を加えるには、確認役が読むワークフローを増やす必要があります（この回では加えていません）
* **洗い出しの範囲の外**：比べるのは、`/etc`の下のファイルとパッケージ、Dockerのコンテナ・イメージ・ネットワーク・ボリュームだけです。**[セクション3](#3-管理外のものを見つける)** の`/var/lib/apt/lists`のように、範囲の外に残ったものは現れません
* **宣言の正しさ**：宣言のリストに載せたものは、何が起きても結果に現れません。たとえば、`/etc/hosts`を宣言しているので、Dockerではなく人が`/etc/hosts`を書き換えても、洗い出しには現れません。宣言は、見えない範囲を記録に残すものですが、その範囲の中を見る仕組みではありません

次のセクションでは、もう1つの「意図して見ない範囲」である`ignore_changes`と、残骸を消すための削除用タスクを見直します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 意図的に外した属性と削除用タスクを見直す

**[セクション2](#2-検知も収束もできない乖離が残っている)** で挙げた4つの乖離のうち、残る2つを見直します。`ignore_changes`で外した属性と、revertの残骸を消すための削除用タスクです。どちらも、意図して入れたものですが、入れた理由が残っていなければ、後から見た人には、見えない範囲がなぜあるのか分かりません。

### ■ 検証内容：`ignore_changes`を一覧にする

リポジトリの`ignore_changes`を一覧にし、それぞれを最初に入れたコミットを`git log -S`で探しました。

**▼ 実行結果**（`grep -rn -B3 -A1 'ignore_changes' terraform --include='*.tf'`から抜粋）

```plaintext
terraform/envs/prod/main.tf:73:    ignore_changes = [build]
terraform/envs/prod/main.tf:87:    ignore_changes = [build]
terraform/envs/prod/main.tf:98:    ignore_changes = [build]
terraform/modules/lab_env/main.tf:21:    ignore_changes = [build]
terraform/modules/lab_env/main.tf:50:    ignore_changes = [network_mode]
```

|場所|外している属性|最初に入れたコミット|理由の記述|
|---|---|---|---|
|モジュールのイメージ（21行辺り）|`build`|第10回（`ffb990c`）|コードにはない。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** の本文と、**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** のセクション7に書かれている|
|モジュールのコンテナ（50行辺り）|`network_mode`|Ansible×Terraformシリーズ第32回の初期構成（`9a248d7`）|コードにも、コミットの見出しにもない|
|prodのイメージ3つ（73・87・98行辺り）|`build`|第10回（`ffb990c`）|コードにはない|

5つとも、コードの中に理由が書かれていませんでした。特に`network_mode`は、どこにも理由が残っていませんでした。

`network_mode`の理由は、推測では書けないため、手元の作業コピーで一時的に`ignore_changes = [network_mode]`の行を消し、devの`plan`を確かめました（`apply`はせず、確かめた後に`git checkout`で元に戻しています）。

**▼ 実行結果**（`ignore_changes = [network_mode]`を消した状態での、devの`terraform plan`から抜粋）

```plaintext
  # module.lab_env.docker_container.targets["dev-node1"] must be replaced
      - network_mode                                = "bridge" -> null # forces replacement
Plan: 1 to add, 0 to change, 1 to destroy.
```

コンテナは`networks_advanced`で専用のネットワークにつないでいますが、Dockerは`network_mode`を`bridge`と返します。コードに`network_mode`を書いていないため、Terraformはその差を作り直しとして計画します。外さなければ、変更がなくても、`plan`のたびにコンテナが作り直しになる、というのが理由でした。

### ■ 検証内容：`ignore_changes`を入れたものが、使われていなかった

prodの`build`の3つを確かめると、その上に、第10回で書いたコメントがありました。

**▼ 実行結果**（`cat -n terraform/envs/prod/main.tf`から抜粋）

```plaintext
    62  # 以下は、どのコンテナも使っていないリソース。管理の範囲の整理は第21回で扱う
    63  resource "docker_image" "ansible_target_deploy_nopasswd" {
（途中省略）
    77  resource "docker_image" "ansible_target_deploy_passwd" {
（途中省略）
    91  resource "docker_image" "ansible_target_legacy" {
（途中省略）
   102  resource "docker_network" "app_net" {
   103    name = "ansible-app-net"
   104  }
```

第10回で、3環境の共通部分をモジュールに移したとき、どのコンテナも使っていない4つのリソース（イメージ3つとネットワーク1つ）を、prodに残していました。管理はされているので、**[セクション3](#3-管理外のものを見つける)** の洗い出しにも、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の検知にも現れません。しかし、何のために管理しているのかは、コードのどこにも書かれていません。`ignore_changes`の見直しが、管理されているのに使われていないものの見直しにつながりました。

ネットワーク`ansible-app-net`を使っているコンテナは0でした（`docker network inspect`の`Containers`が空）。3つのイメージの`Dockerfile`は、このprodの定義からだけ参照されていました。使われていない理由を書いて残すより、**[セクション4](#4-見つけたものを3つに振り分ける)** の「削除する」に振り分けました。あわせて、このリソースだけが使っていた変数`deploy_user_password`と、3つの`Dockerfile`も消しました。

### ■ 検証内容：削除用タスクを外してよいかを確かめる

**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** で入れた削除用タスク`rollback_cleanup.yml`（ユーザー`gitops11`と`/etc/gitops11-rollback.conf`を消すタスク）が、まだロールに残っていました。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** のセクション7の基準（このタスクを含むコミットが、すべての環境に適用されている）と、実物に対象が残っていないことを確かめました。

**▼ 実行結果**

```plaintext
dev last_applied=ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
stg last_applied=ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
prod last_applied=ebe9dcf2df98e2866c6510a51e517e8f6a0e7a02
dev contains_5f5208d=0
stg contains_5f5208d=0
prod contains_5f5208d=0
== dev-node1
getent_exit_code=2
ls: cannot access '/etc/gitops11-rollback.conf': No such file or directory
（stg-node1、target-node1〜3も同じ）
```

3環境とも、最後に適用したコミットが、削除用タスクを入れたコミット（`5f5208d`）を含んでいて（`git merge-base --is-ancestor`の終了コード0）、5台ともユーザー`gitops11`も`/etc/gitops11-rollback.conf`もありません。

削除用タスクがある間は、`/etc/gitops11-rollback.conf`は「Playbookが扱うパス」として、**[セクション3](#3-管理外のものを見つける)** の洗い出しから差し引かれます。タスクを外した後の洗い出しで何も出なければ、本当に残っていないことの確認にもなります。

### ■ 検証内容：見直しの結果を、1つのプルリクエストで適用する

見直しの結果を、1つのプルリクエスト（PR#135）にまとめました。

* モジュールの2つの`ignore_changes`の上に、理由のコメントを書いた
* prodの使っていない4つのリソース、変数`deploy_user_password`、3つの`Dockerfile`を消した
* `rollback_cleanup.yml`を消し、`tasks/main.yml`から読み込みの2行を消した

コメントを書いた後のモジュールは、次のとおりです（コメントの出典を1か所誤って書いたため、別のプルリクエスト（PR#136）で直した後のもの）。

* **ファイル名：`terraform/modules/lab_env/main.tf`（`ignore_changes`の部分）**

```hcl
  lifecycle {
    # buildのcontextの文字列が変わっただけで、イメージとコンテナが作り直されるのを避けるため（GitOps第10回）。
    # その代わり、Dockerfileを変えても、このイメージは作り直されない（GitOps第17回）。
    ignore_changes = [build]
  }
（途中省略）
  lifecycle {
    # networks_advancedでつないでも、Dockerはnetwork_modeをbridgeと返す。
    # 書かないと、planのたびにコンテナの作り直しになるため（GitOps第21回で確かめた）。
    ignore_changes = [network_mode]
  }
```

PR#135の確認の実行（「GitOps Pipeline」の実行#218）の`terraform-plan`は、devとstgで`No changes.`、prodで4つの削除でした。マージし（マージコミット`c4877db`、「GitOps Pipeline」の実行#219）、dev（「GitOps Apply」の実行#134）とstg（「GitOps Apply」の実行#135）に適用しました。

prodには、まず`allow_destroy`を付けずに適用しようとしました（「GitOps Apply」の実行#136）。

**▼ 実行結果**（「GitOps Apply」の実行#136、`verify`ジョブのステップ「Check plan policy」から抜粋）

```plaintext
f944ca008a76a5180d4f1aaac19dfe7639f53be37c22235baa0d2d9e0a28bcbb  /home/control/gitops-pending/prod/tfplan
BLOCK docker_image.ansible_target_deploy_nopasswd actions=delete reason=delete_because_no_resource_config
BLOCK docker_image.ansible_target_deploy_passwd actions=delete reason=delete_because_no_resource_config
BLOCK docker_image.ansible_target_legacy actions=delete reason=delete_because_no_resource_config
BLOCK docker_network.app_net actions=delete reason=delete_because_no_resource_config
policy: blocked (4)
##[error]plan contains delete or replace; dispatch again with allow_destroy to apply it to prod
```

「削除する」と決めてコードから外しても、prodでは、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** の`plan-policy.sh`が止めます。`allow_destroy`を付けて適用し直しました（「GitOps Apply」の実行#137）。

**▼ 実行結果**（「GitOps Apply」の実行#137、`verify`ジョブのステップ「Check plan policy」から抜粋）

```plaintext
f944ca008a76a5180d4f1aaac19dfe7639f53be37c22235baa0d2d9e0a28bcbb  /home/control/gitops-pending/prod/tfplan
（途中省略）
policy: blocked (4)
##[warning]delete or replace is allowed by allow_destroy
```

**▼ 実行結果**（「GitOps Apply」の実行#137、`terraform-apply`ジョブから抜粋）

```plaintext
docker_image.ansible_target_deploy_nopasswd: Destroying... [id=sha256:04afd2e3f7a2ad7572f5764b1debfb4f1f7be5c9a43f00f85dda697cc482620cansible-target:deploy-nopasswd]
docker_image.ansible_target_legacy: Destroying... [id=sha256:a16c62a2699b6a0020002e924eff95e64e701b5f89b92247875e66365ced49b0ansible-target:ubuntu18.04]
docker_image.ansible_target_deploy_passwd: Destroying... [id=sha256:04afd2e3f7a2ad7572f5764b1debfb4f1f7be5c9a43f00f85dda697cc482620cansible-target:deploy-passwd]
docker_network.app_net: Destroying... [id=241cceaae174c6dc1b65ccd0ab0ea73cfc010ea323eaf244c374875cb5bba3a8]
docker_image.ansible_target_deploy_nopasswd: Destruction complete after 1s
docker_image.ansible_target_deploy_passwd: Destruction complete after 1s
docker_network.app_net: Destruction complete after 3s
docker_image.ansible_target_legacy: Destruction complete after 4s

Apply complete! Resources: 0 added, 0 changed, 4 destroyed.
```

適用の後、「Unmanaged Detect」を起動しました（「Unmanaged Detect」の実行#4）。

**▼ 実行結果**（「Unmanaged Detect」の実行#4、`find`ジョブから抜粋）

```plaintext
RESULT dev=none exit_code=0 ref=c4877db9551c86d5153a2507d6cc24787656d328
RESULT stg=none exit_code=0 ref=c4877db9551c86d5153a2507d6cc24787656d328
RESULT prod=none exit_code=0 ref=c4877db9551c86d5153a2507d6cc24787656d328
RESULT docker=none exit_code=0 ref=c4877db9551c86d5153a2507d6cc24787656d328
```

### ■ 結果

|見直したもの|見直しの前|見直しの後|
|---|---|---|
|モジュールの`build`|`ignore_changes`で外している理由が、コードになく、第10回と第17回の本文にだけ書かれていた|理由と、見えなくなるもの（`Dockerfile`の変更）をコメントに書いた|
|モジュールの`network_mode`|`ignore_changes`で外している理由が、コードにも、コミットの見出しにもなかった|`plan`で確かめた理由をコメントに書いた|
|prodの4つのリソース|どのコンテナも使っていないイメージ3つ（`ignore_changes = [build]`付き）とネットワーク1つが、管理されていた|削除した（`allow_destroy`を付けた適用で）|
|`rollback_cleanup.yml`|削除用タスクが、消す対象がすべての環境からなくなった後も、ロールに残っていた|基準を確かめてから外した。外した後の洗い出しでも、管理外は出ない|

`ignore_changes`は、外す理由がある限り残ります。コメントを書いても、見えない範囲は狭くなりません。変わったのは、その範囲が「なぜあるのか分からないもの」から「理由が分かるもの」になったことです。理由が分かれば、次に見直すとき、その理由がまだ成り立つかを確かめられます。一方で、理由を探した結果、使われていないリソースが見つかったように、見直しは、見えない範囲そのものを狭めることにもつながります。

### 見直しの後も残るもの

* **使われなくなったSecret**：3つのワークフロー（「GitOps Pipeline」、「Drift Detect」、「Unmanaged Detect」）は、環境変数`TF_VAR_deploy_user_password`として、Secret`TF_VAR_DEPLOY_USER_PASSWORD`をまだ読み込んでいます。変数を消したので、Terraformはこの値を使いません。また、このSecretを読み込んだジョブのログでは、リソースの名前の`deploy`の部分が`***`に置き換わっていました（「GitOps Pipeline」の実行#218の`terraform-plan`ジョブ）。読み込んでいない`verify`ジョブのログでは、置き換わっていません。Secretの値と同じ文字列が伏せられるため、伏せ方から値が推測できる状態でした。ワークフローとSecretの整理は、この回では行っていません
* **別のプロジェクトのtfstate**：Ansible×Terraformシリーズの検証で使っていたプロジェクト（`~/iac/docker-lab`）のtfstateには、今回消したイメージの記録が残っています。このパイプラインの3環境の外にあるtfstateなので、ここでは扱っていません
* **残っている`ignore_changes`**：モジュールの2つは、理由を書いたうえで残しています。`Dockerfile`を変えてもイメージが作り直されないことと、`network_mode`の差が見えないことは、変わりません

次のセクションでは、何を管理の対象にし、何を管理外と宣言するかの判断の基準を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. どこまで管理するかを決める

**[セクション4](#4-見つけたものを3つに振り分ける)** から **[セクション6](#6-意図的に外した属性と削除用タスクを見直す)** で、見つけたものを1つずつ振り分けてきました。ここでは、その判断を並べ直し、何を管理の対象にし、何を管理外と宣言するかの基準を取り出します。

### この回で下した判断を並べる

振り分けたものを、「その状態を誰が決めているか」で並べると、次のようになります。

|状態を決めているもの|この回で見つけたもの|振り分けと理由|
|---|---|---|
|Docker|`/etc/hostname`、`/etc/hosts`、`/etc/resolv.conf`、ネットワーク`bridge`・`host`・`none`|**管理外と宣言する**。コンテナの起動のたびに、Dockerが書き直す。PlaybookやTerraformで書いても、Dockerが上書きする|
|Playbookの副作用|`/etc/shadow`、`/etc/shadow-`、`/etc/passwd-`|**管理外と宣言する**。ユーザー`ansible`のパスワードのタスクが書き換える。タスク自体は管理しているが、書き換わるファイルはタスクの`dest`や`path`に現れない|
|パイプラインの土台|コンテナ`tfstate-pg`、イメージ`postgres:17`、ボリューム`tfstate-pg-data`|**管理外と宣言する**。tfstateを置く場所は、`terraform init`の時点で接続できなければならない。同じtfstateの中では管理できない|
|別の仕組み|イメージ`ansible-target:immutable`、ボリューム`target-node1-data`（別のプロジェクトのtfstate）、`ubuntu:22.04`（`Dockerfile`の`FROM`）|**管理外と宣言する**。ほかのtfstateや、イメージを作る手順が使っている。このパイプラインの3環境では管理しない|
|検証のための道具|イメージ`alpine:latest`、`hello-world:latest`|**管理外と宣言する**。一時的なコンテナの元と、Dockerの動作確認に使う|
|なし（残したい）|`/etc/gitops21-keep.conf`、コンテナ`gitops21-import`|**取り込む**。手で置いたもので、決めている仕組みがない。PlaybookやTerraformに書けば、パイプラインが決める側になる|
|なし（残す理由がない）|`/etc/gitops21-drop.conf`、prodの使っていない4つのリソース|**削除する**。残す理由を書けない。prodの4つは管理はされていたが、何のために管理しているのかが書かれていなかった|
|なし（残骸）|`rollback_cleanup.yml`が消す対象（ユーザー`gitops11`、`/etc/gitops11-rollback.conf`）|**削除用タスクを外す**。消す対象が、すべての環境から消えている|

管理外と宣言したものには、どれも、状態を決めている別のものがあります。取り込んだもの、削除したものには、状態を決めているものがありませんでした。

### 基準は「その状態を誰が決めているか」

この並びから、判断の基準は次のようにまとめられます。

* **状態を決めているものがない**なら、取り込むか、削除する。どちらにするかは、その状態を残したいかで決める。残したいなら取り込み、パイプラインが決める側になる。残す理由を書けないなら削除する
* **状態を決めているものが別にある**なら、管理外と宣言し、宣言の理由に、それが何かを書く。PlaybookやTerraformで同じものを決めようとすると、決める側が2つになり、互いに書き換え合うか、片方の記述が実際の状態と合わなくなる
* **状態を決めているものが、パイプラインの土台そのもの**なら、同じパイプラインでは管理しない。tfstateの置き場所のように、パイプラインが動く前から必要なものは、パイプラインの外で管理していることを宣言する

宣言のリストの理由の欄は、この「別にある、状態を決めているもの」を書く場所です。**[セクション4](#4-見つけたものを3つに振り分ける)** で「理由を書けないものは宣言しない」としたのは、決めているものを書けないなら、それは「状態を決めているものがない」側に入り、取り込むか削除するかを決めるべきものだからです。

### 取り込むと、意図して見ない範囲が増えることがある

取り込みは、管理の範囲を広げます。ただし、**[セクション4](#4-見つけたものを3つに振り分ける)** のコンテナ`gitops21-import`では、取り込むために`env`を`ignore_changes`で外す必要がありました。プロバイダーが実物から読み戻せない属性は、取り込んだ後も比べられません。

|振り分け|検知の範囲|意図して見ない範囲|
|---|---|---|
|取り込む|広がる|プロバイダーが読み戻せない属性の分だけ、増えることがある|
|削除する|変わらない（対象がなくなる）|対象がなくなるので、増えない|
|管理外と宣言する|変わらない|宣言した分だけ、記録された形で増える|

どの振り分けを選んでも、見えない範囲がゼロになるわけではありません。違いは、見えない範囲が、理由とともに記録されているかどうかです。**[セクション6](#6-意図的に外した属性と削除用タスクを見直す)** で`ignore_changes`に理由を書いたのも、宣言のリストに理由を書いたのも、同じ目的です。

### 洗い出しの範囲も、管理の範囲の一部

この回の洗い出しは、`/etc`の下のファイル、パッケージ、Dockerのコンテナ・イメージ・ネットワーク・ボリュームを比べました。**[セクション3](#3-管理外のものを見つける)** では、`apt-get update`が取得したパッケージの一覧が、`/etc`の外にあるため現れませんでした。**[セクション4](#4-見つけたものを3つに振り分ける)** では、最初のスクリプトがボリュームを見ていなかったことに、別のtfstateの記録を調べて初めて気づきました。

範囲を広げれば、見つかるものは増えます。一方で、ログや一時ファイルのように、動いているだけで変わるものを範囲に入れると、洗い出しは毎回それを出し、本当に見るべきものが埋もれます。この回で`/etc`に絞ったのは、そのためです。

洗い出しの範囲は、スクリプトの中（`SCAN_DIRS`と、比べるリソースの種類）に書かれています。範囲の外は、宣言のリストにも載らず、洗い出しの結果にも現れません。どこまでを洗い出すかも、宣言と同じく、決めて記録しておくものです。

### 判断の順番

ここまでをまとめると、見つけたものを振り分ける順番は次のとおりです。

1. その状態を決めているものが、別にあるか
   * ある：管理外と宣言し、決めているものを理由に書く
   * ない：2へ
2. その状態を残したいか
   * 残したい：取り込む。取り込むために`ignore_changes`が必要なら、その理由もコードに書く
   * 残す理由を書けない：削除する。削除用タスクは、すべての環境に適用してから外す
3. どの振り分けでも、変更はプルリクエストにし、通常の経路で適用する

この順番は、Dockerのコンテナでも、ほかのプロバイダーでも変わりません。

次のセクションでは、この設計を、クラウドのプロバイダーに当てはめます。

---

[↑ 目次に戻る](#-目次)

---

## 8. クラウドでも同じ設計で範囲を狭められる

この回の検証は、Dockerのコンテナを操作対象にしています。ここでは、この回で作った仕組みのうち、どこがプロバイダーに依存せず、どこをプロバイダーに合わせて置き換えるかを整理します。クラウドのプロバイダーでの検証は、この回では行っていません。

### 置き換えるのは、「実際の一覧」を取る部分だけ

洗い出しは、「実際の状態」から「記述・記録されている範囲」と「宣言した範囲」を差し引く、という形でした。この形のうち、プロバイダーによって変わるのは、実際の状態の一覧を取る部分だけです。

|部分|この回（Docker）|クラウドのプロバイダー|
|---|---|---|
|操作対象の中の実際の状態|`docker exec`でパッケージとファイルを読む|SSHやエージェントで、同じくパッケージとファイルを読む。Ansibleの側は、プロバイダーに依存しない|
|比べる基準|同じイメージから作った一時的なコンテナ|同じイメージ（マシンイメージ）から作った状態。基準をどう用意するかは、プロバイダーとコストに合わせて決める|
|Playbookが扱うパス|確認モードの結果の`dest`と`path`|同じ|
|プロバイダーのリソースの実際の一覧|`docker ps`、`docker image ls`、`docker network ls`、`docker volume ls`|プロバイダーのAPIやCLIで、アカウントやプロジェクトにあるリソースの一覧を取る|
|記録されている範囲|3環境のtfstate（`terraform show -json`）|同じ|
|宣言の範囲|`.github/unmanaged-declared.txt`|同じ形のリスト|

`terraform show -json`でtfstateから記録を取り出す部分と、宣言のリストで差し引く部分は、プロバイダーが変わっても、そのまま使えます。置き換えるのは、表の4行目の「実際の一覧を取る」部分だけです。

### 宣言するものの種類も、同じ考え方で決まる

**[セクション7](#7-どこまで管理するかを決める)** の基準（その状態を誰が決めているか）は、クラウドでも同じように当てはまります。

|この回の例|クラウドで同じ位置にあるもの（例）|
|---|---|
|Dockerが最初から持っているネットワーク（`bridge`、`host`、`none`）|プロバイダーが最初から作るリソース。たとえばAWSでは、リージョンごとにデフォルトVPCが作られている|
|Dockerが書く`/etc/hostname`など|プロバイダーが、インスタンスの起動時に書き込む設定|
|tfstateを置く`tfstate-pg`|tfstateを置くストレージ。`terraform init`の時点で必要なので、同じtfstateでは管理しない|
|別のプロジェクトのtfstateに記録されているイメージ|ほかのチームやほかのパイプラインが、別のtfstateで管理しているリソース|

クラウドのアカウントでは、1つのアカウントを複数のパイプラインやチームが使うことが多く、「別のtfstateに記録されている」ものの割合は、この回より大きくなります。どのtfstateと突き合わせるかで管理外かどうかが変わることは、**[セクション4](#4-見つけたものを3つに振り分ける)** で確かめたとおりです。突き合わせるtfstateを増やすか、宣言のリストで「どのパイプラインが管理しているか」を理由に書くかを、決めておく必要があります。

### 取り込みと`ignore_changes`も、同じ経路を通る

**[セクション4](#4-見つけたものを3つに振り分ける)** で使った`import`ブロックは、Terraform本体の機能で、プロバイダーに依存しません。`import`ブロックを書けば、取り込みも`plan`に現れ、プルリクエスト、ガードレール、承認ゲート、dev→stg→prodの昇格という同じ経路で適用できます。

一方で、この回で確かめたことのうち、次の2つは、プロバイダーごとに確かめ直す必要があります。

* `-generate-config-out`で書き出した定義が、そのままでは取り込みにならず、作り直しの計画になった。どの属性が原因になるかは、プロバイダーとリソースの種類による
* 取り込んだときのtfstateに入らない属性（この回では`env`）があり、`ignore_changes`で外す必要があった。どの属性が読み戻せないかも、プロバイダーによる

どちらも、`plan`の結果で`forces replacement`の印と、作り直しの数を確かめれば分かります。取り込みのプルリクエストでは、`plan`が「取り込みと、その場の更新だけ」になっていることを、適用の前に確かめます。

### 定期的に動かす形も、そのまま使える

「Unmanaged Detect」は、最後に適用したコミットのコードを取り出し、洗い出しの結果を`none`・`found`・`find_failed`に分けて、Issueに残しました。この流れは、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** の検知と同じく、プロバイダーに依存しません。プロバイダーのAPIを読むための認証情報を、検知のワークフローと同じくSecretsから渡せば、同じ形で定期的に動かせます。

この回で作った設計は、管理の範囲を「実際の状態から差し引く」形で見つけ、その判断をGitに記録するものでした。差し引く元の一覧をどこから取るかが変わるだけで、範囲を狭める手順は、Dockerでもクラウドでも同じです。

次のセクションでは、この回の内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 9. まとめ

この回で整理した内容を確認します。

* **[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** から **[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** で作った検知、自動収束、例外経路は、どれもコードに記述され、tfstateに記録されているものの内側で働く。タスクに記述されていない要素、tfstateに記録されていないリソース、revertの残骸、`ignore_changes`で外した属性の4つは、検知の仕組みをどれだけ整えても、検知の結果に現れない
* 操作対象とDockerの実際の状態から、Playbookが扱うパス、Terraformがコンテナに置くパス、tfstateの記録を差し引くと、管理の外にあるものを洗い出せる。手で足したパッケージ、ファイル、書き換え、Terraformの外のコンテナの4つを、`terraform plan`、確認モード、「Drift Detect」がすべて差分なしと判定した状態で、洗い出しは4つとも見つけた
* 見つけたものは、「取り込む」「削除する」「管理外と宣言する」の3つに振り分け、どれもプルリクエストとして通常の経路で適用する。宣言には理由を書き、Terraformの外のリソースは`import`ブロックで、`plan`と承認ゲートを通して取り込む。取り込むために、プロバイダーが読み戻せない属性を`ignore_changes`で外す必要が出ることもある
* 洗い出しは、新しいワークフロー「Unmanaged Detect」として「Drift Detect」と並べて定期的に動かし、結果をIssueに残す。見つけたものは自動で戻さず、振り分けを人に返す
* `ignore_changes`には、外した理由と、見えなくなるものをコードに書く。理由を探す中で、管理されているのに使われていないリソースが見つかれば、削除する。削除用タスクは、それを含むコミットがすべての環境に適用され、対象が残っていないことを確かめてから外す
* 何を管理し、何を管理外と宣言するかは、「その状態を誰が決めているか」で決まる。決めているものが別にあれば、それを理由に書いて宣言する。なければ、残したいものは取り込み、残す理由を書けないものは削除する
* この設計は、クラウドのプロバイダーでも変わらない。置き換えるのは、プロバイダーのリソースの実際の一覧を取る部分だけで、tfstateとの突き合わせ、宣言のリスト、`import`ブロックによる取り込み、定期的な実行の形は、そのまま使える

この回で、**[ドリフトシリーズ第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-04/)** の「防ぐ」をパイプラインの上で実装し、第4部（ドリフト検知と自動収束）と「Ansible×TerraformをGitOpsで回す」を締めくくります。第4部の5回（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** 〜第21回）で作った、ドリフトの区別・検知・収束・例外・予防は、シリーズ統合ブログで、「最後に適用したコミット」という1本の軸でつなげて整理します。

---

📑 連載の移動　**[前の記事：【GitOps編】第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第4部まとめブログ：ドリフトの区別・検知・収束・例外・予防を「最後に適用したコミット」でつなぐ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 10. 連載一覧：「Ansible×TerraformをGitOpsで回す」

### 第4部：ドリフト検知と自動収束

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)**|GitOps環境でドリフトはなぜ起きるのか|ドリフトシリーズの、記述されていない要素は比較の対象にならないというルールが、Ansible・Terraform・GitOpsの3か所で現れることを示す。第1回の3つの経路が第2部・第3部を経ても残ることと、承認・昇格・revertが生む食い違いを整理する。「main」「最後に適用したコミット」「実環境」の3つの状態を区別し、マージ済みで未適用の状態とコンテナの属性の手動変更を実機で作って、未適用の差分とドリフトを記録で見分ける。第4部の初回。|
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**|定期実行でドリフトを自動検知する|環境ごとに「最後に適用したコミット」のコードで実環境を比べ、結果を「差分なし」「差分あり」「検知失敗」の3つに分ける定期検知を作る。stateのロックとの衝突を同時実行のグループとロックの待ち時間で扱い、検知が止まったことをホステッドランナーの確認役から気づけるようにする。結果を環境ごとに1つのIssueに残し、昇格の途中の複数環境でも環境ごとに独立して検知できることを確かめる。Ansible×Terraformシリーズ第37回の深掘り版として位置づける。|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**|ドリフトを検知したら自動収束させる|収束先をmainではなく環境ごとに最後に適用したコミットに限り、検知の時点で保存したplanで検知した差分だけを戻す自動収束を作る。作り直し・削除・作成と検知失敗は人に返し、ガードレールの結果を確かめてから戻す。収束の後の再検知で、収束しないPlaybookによる繰り返しを止める。自動収束が直せないものを整理し、障害対応の手動変更まで元に戻されることを実機で確かめる。|
|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)**|緊急対応の手動変更とGitOpsを両立させる|障害対応の変更を、Gitを経由する高速経路と、Gitを経由しない手動変更に分け、どちらにも記録と期限を課す。昇格の順序だけを記録付きで短縮し、ガードレールと保存したplanの適用は短縮しない。自動収束を理由と期限を持つ形で一時停止し、一時停止中も検知を続け、期限が来れば解除の操作なしに戻ることを確かめる。手動変更をGitに戻した場合と戻さなかった場合を実機で確かめ、場当たり的な回避との違いを記録・期限・戻し方で整理する。|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**|検知できないドリフトを減らす：管理対象の範囲を広げる設計|検知も自動収束もできない「記述・記録されていない乖離」を扱い、ドリフトシリーズ第4回の「防ぐ」をGitOps上で実装する。操作対象の実際の状態から、Playbook・Terraformのコード・tfstateの範囲を差し引いて管理外のものを洗い出し、「取り込む」「削除する」「管理外と宣言する」に振り分けて、すべてをプルリクエストとしてGitに記録する。洗い出しを定期検知と並べて動かし、`ignore_changes`に理由を書いて、使っていないリソースと削除用タスクを見直す。何を管理するかの基準を「その状態を誰が決めているか」で整理する。第4部・シリーズの最終回。|

---

[↑ 目次に戻る](#-目次)

---