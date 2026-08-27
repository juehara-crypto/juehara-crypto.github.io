---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第27回：再起動、再生成に伴うプロビジョニング断絶'
description: 'VM環境のrebootモジュールに相当する操作が、再起動、再生成のタイミングでAnsibleとTerraformの連携にどのような接続断絶をもたらすかを整理する。Terraformのlocal-execがこの断絶を受動的にしか観測できない構造と、その対処設計を概念レベルで解説する。'
pubDate: '2026-08-29'
category: 'infra'
tags: ['Ansible', 'Terraform', 'reboot', 'reboot_timeout', 'IaC']
seriesId: 'ansible-terraform-part3'
seriesNo: 27
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [OS再起動とAnsibleのrebootモジュールの動作](#2-os再起動とansibleのrebootモジュールの動作)
3. [local-exec経由での再起動時における接続断絶の観測され方](#3-local-exec経由での再起動時における接続断絶の観測され方)
4. [Terraform local-execの受動的な巻き込まれ方](#4-terraform-local-execの受動的な巻き込まれ方)
5. [タイムアウトの二重管理](#5-タイムアウトの二重管理)
6. [対処設計](#6-対処設計)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「`reboot`モジュールを使えば、OS再起動は自動で処理される」と考えたことはないでしょうか。

**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** では、becomeの認証時に、パスワード入力を要求するオプションを指定した場合に限り、非対話実行環境で処理が無応答のまま停止する構造を扱いました。**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** となる今回も、「処理は正常に進んでいるのに、異常に見える」という現象を扱います。ただし原因はbecomeではなく、OS再起動に伴う接続断絶の扱いにあります。

Ansibleでカーネル更新等のためにOS再起動を要求すると、対象ホストへのSSH接続は一時的に失われ、再起動が完了した時点で再び接続可能になります。この「接続が失われてから戻ってくるまでの間」を、Ansible、Terraformの双方がどう扱うかが、この回のテーマです。

Ansibleの`reboot`モジュールは、この再起動と再接続の一連の流れを扱うために用意されたモジュールです。しかし、Terraformの`local-exec`プロビジョナー経由でAnsibleを実行する構成では、この再起動によって生じる一時的な接続断絶が、Terraform側からは正常な処理と区別のつかない形で観測されます。この回では、再起動という正規の操作がどのようにTerraform側の処理に影響するのかを、構造として整理します。

なお、この回で扱う再起動は、Ansibleの`reboot`モジュールが本来想定しているOSレベルの再起動を前提とします。コンテナ環境ではホストのカーネルを共有するためOS再起動という概念自体が成立せず、`docker restart`のような形での代替になりますが、この置き換えについては本文の対象外とし、VM、クラウドインスタンスといった、OS再起動が実際に成立する環境を前提に整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. OS再起動とAnsibleのrebootモジュールの動作

この回の前提となる、Ansibleの`reboot`モジュールがどのような処理を行っているかを整理します。

Ansibleには、対象ホストのOS再起動を扱うための`reboot`モジュールが用意されています。単純に再起動コマンドを実行するだけであれば`command`モジュールや`shell`モジュールでも可能ですが、それだけでは再起動によって切断されたSSH接続がいつ復旧するかをAnsible自身が把握できません。`reboot`モジュールは、この再起動と再接続の一連の流れをモジュール内部で完結させるために存在します。

`reboot`モジュールが内部で行っている処理は、大きく分けて次の4段階です。

```plaintext
1. 対象ホストに再起動コマンド（systemctl reboot等）を実行する
　↓
2. SSH接続が切断されたことを検知する
　↓
3. reboot_timeoutで指定された時間（デフォルト600秒）の範囲内で、
　 SSH接続が復旧するまで定期的に再接続を試みる
　↓
4. 再接続後、ホストが実際に起動を完了しているかを確認し、処理を継続する
```

この4段階のうち、2から3にかけての「接続が切れてから戻ってくるまで」の区間が、この回で扱う接続断絶の本体にあたります。`reboot`モジュールは、この区間をエラーとして扱うのではなく、再起動に伴う正常な過程として扱うよう設計されています。

`reboot`モジュールを単体で、あるいは`ansible-playbook`を手元の端末やCI環境から直接実行するケースでは、この一連の流れはモジュール内部で完結します。呼び出し元（実行者やCI環境）から見れば、`reboot`タスクは実行に一定の時間を要するものの、最終的には「正常終了した1つのタスク」として結果が返ってきます。接続が切れている間の待機や再試行は、すべて`reboot`モジュールが引き受けており、呼び出し元がその過程を個別に意識する必要はありません。

この「呼び出し元は待機の過程を意識しなくてよい」という前提が、次のセクションで扱う、Terraformの`local-exec`経由での実行において、そのまま成り立つかどうかが問題になります。

---

[↑ 目次に戻る](#-目次)

---

## 3. local-exec経由での再起動時における接続断絶の観測され方

セクション2で確認した`reboot`モジュールの4段階が、Terraformの`local-exec`プロビジョナー経由で実行された場合にどう見えるかを整理します。

`local-exec`は、指定されたコマンド（この構成では`ansible-playbook`）をシェルの子プロセスとして起動し、そのプロセスが終了するまで待機します。`local-exec`自身は、起動した子プロセスの内部で何が起きているかを関知しません。子プロセスが最終的にどのような終了コード（exit status）を返すかだけを見ています。

この構造を、`reboot`タスクを含むPlaybookの実行に当てはめると、次のようになります。

```plaintext
Terraform（local-exec）
　└─ ansible-playbookを子プロセスとして起動
　　　└─ Ansible内部でrebootタスクが実行される
　　　　　├─ 再起動コマンドの送信
　　　　　├─ SSH接続の切断
　　　　　├─ reboot_timeout内での再接続試行
　　　　　└─ 再接続、起動完了確認、タスク正常終了

Terraformから見えているのはこの間ずっと「子プロセスがまだ終わっていない」という状態のみ
```

セクション2で確認した通り、`reboot`モジュールは接続断絶を異常としてではなく、再起動に伴う正常な過程として扱います。しかし、この「正常な過程である」という情報は、`reboot`モジュールと、それを呼び出している`ansible-playbook`プロセスの内部にとどまっています。`local-exec`から見た場合、子プロセスが応答を返さない状態が続いているという事実だけが観測され、それが「`reboot_timeout`の範囲内で正常に再接続を待っている状態」なのか、あるいは「何らかの理由で処理がハングしている状態」なのかを、`local-exec`側から区別する手段はありません。

この構造は、**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** で確認した、becomeパスワードのプロンプト入力待ちによる無応答停止とも共通しています。**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** では、`ansible-playbook`の子プロセスがBECOMEパスワードの入力待ちのまま残り続け、`local-exec`側もその終了を待ち続けることで、`terraform apply`全体が先に進まない状態になっていました。今回のrebootタスクも、待機の理由こそ異なりますが、「子プロセスが正常な理由で時間を要しているのか、異常な理由で停止しているのかを、`local-exec`側からは区別できない」という点では同じ構造を持っています。

異なるのは、第26回のBECOMEパスワード待ちには`reboot_timeout`に相当する上限が事実上存在せず（プロンプトへの応答がなければ無期限に待ち続ける）、一方の`reboot`タスクには`reboot_timeout`という明示的な上限が設定されている、という点です。この上限の有無が、次のセクション以降で扱うタイムアウト管理の問題につながります。

---

[↑ 目次に戻る](#-目次)

---

## 4. Terraform local-execの受動的な巻き込まれ方

セクション3では、`reboot`タスクの実行中に生じる接続断絶を、`local-exec`が区別なく観測している構造を確認しました。ここでは視点を広げ、この受動性がreboot固有のものではなく、`local-exec`経由でAnsibleを実行する構成そのものに共通する構造であることを整理します。

`local-exec`は、子プロセスとして起動した`ansible-playbook`が何を実行しているかにかかわらず、その終了だけを待つという振る舞いを一貫して取ります。この振る舞いは、これまでの回でも繰り返し形を変えて現れてきました。

```plaintext
第21回：ネストされたエラーログの解析
　→ ansible-playbook内部でエラーが発生していても、
　　local-execはそのエラーがTerraform側の問題かAnsible側の問題か区別しない

第26回：becomeパスワードのプロンプト入力待ち
　→ ansible-playbookが応答待ちで停止していても、
　　local-execはそれが正常な待機か異常な停止か区別しない

第27回：rebootタスクによる接続断絶
　→ ansible-playbookが再接続を試行中であっても、
　　local-execはそれが正常な再起動待ちか異常なハングか区別しない
```

これらに共通しているのは、`local-exec`が「子プロセスの終了」という単一の情報だけを頼りに動作しているという点です。子プロセスの内部でどのような状態遷移が起きているか、その状態が正常か異常かという判断材料は、`local-exec`の外側には伝わりません。`local-exec`にとって、子プロセスは開始と終了という2つの時点だけを持つブラックボックスであり、その間に何が起きているかは関知の対象外です。

この受動性は、`local-exec`というプロビジョナーの実装上の欠陥ではなく、シェルコマンドを起動してその終了を待つという、`local-exec`本来の役割から必然的に導かれる性質です。Terraformは本来、インフラリソースの状態を宣言的に管理するツールであり、`local-exec`はその宣言的な管理の枠組みの中に、任意のシェルコマンドを実行するための限定的な出口として用意されています。子プロセスの内部状態を逐一監視し、それが正常か異常かを判断する機能は、`local-exec`の設計思想の外にあります。

この構造を踏まえると、rebootタスクに限らず、`local-exec`経由でAnsibleを実行する構成全体において、「子プロセスが時間を要している間、それが正常な処理なのか異常な停止なのかを、Terraform側だけで判断することはできない」という前提を置く必要があります。次のセクションでは、この前提のもとで、rebootタスクに特有のタイムアウト管理の問題を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. タイムアウトの二重管理

セクション3で触れた通り、Ansibleの`reboot`モジュールには`reboot_timeout`という明示的な上限が設定されています。ここでは、この上限がTerraform側のタイムアウト管理とどう関係するかを整理します。

`reboot`モジュールが持つタイムアウト関連のパラメータには、主に次の2つがあります。

```plaintext
reboot_timeout : SSH接続が復旧するまで待機する上限時間（デフォルト600秒）
connect_timeout: 個々の再接続試行1回あたりのタイムアウト（デフォルト5秒）
```

`reboot_timeout`は、再起動によって切断された接続が復旧するまで、Ansibleがどれだけ待ち続けるかを制御します。この時間内に接続が復旧すれば、`reboot`タスクは正常終了として扱われます。復旧しなければ、タスクは失敗として終了し、その失敗は`ansible-playbook`全体の異常終了（エラーを伴う終了コード）として、呼び出し元に伝わります。

一方、Terraform側には、`local-exec`プロビジョナー自体に明示的なタイムアウト上限は存在しません。`local-exec`は、`timeout`引数を指定しない限り、子プロセスが終了するまで無期限に待ち続けます。この点は、**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** で確認したBECOMEパスワード待ちの無応答停止と同じ前提です。

ただし、`local-exec`自体に上限がなくても、Terraformを呼び出している外側の環境には、別のタイムアウトが存在することが一般的です。CI/CDパイプラインのジョブタイムアウト、運用担当者が待てる現実的な時間の上限などが、これにあたります。この「外側のタイムアウト」と、`reboot_timeout`という「内側のタイムアウト」は、互いを意識せずに、それぞれ独立して設定されているという点が、この回で扱う二重管理の構造です。

```plaintext
【Ansible側（内側）】
reboot_timeout: 600
（600秒まで、再起動後の再接続を試行し続ける）

【Terraformの外側】
明示的なタイムアウト設定がない場合、local-exec自体には待機上限がない
　→ ただし、Terraformを呼び出す外部環境（CI/CDのジョブタイムアウト等）が
　　別途存在するケースが多い
```

この2つのタイムアウトの関係によって、次のようなケースが起こり得ます。仮に外側のジョブタイムアウトが300秒に設定されていた場合、Ansible側の`reboot_timeout`（600秒）はまだ余裕を残した状態であるにもかかわらず、外側のタイムアウトが先に働き、Terraformの実行自体が強制終了させられます。この場合、Ansible側からすれば「まだ正常な再試行の範囲内だった」処理が、外側の都合によって途中で打ち切られることになります。

逆に、外側のタイムアウトがAnsible側の`reboot_timeout`より十分長く設定されていれば、この打ち切りは起こりません。しかし、この2つの値が互いを参照せずに、別々の担当者、別々のタイミングで設定されるという運用が続く限り、両者の関係がどうなっているかは、意識的に確認しない限り分かりません。

次のセクションでは、この二重管理を踏まえた対処設計を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 対処設計

セクション2から5で整理した内容を踏まえ、対処のパターンを整理します。

### タイムアウトの整合を取る

セクション5で確認した二重管理への対処として、まず基本になるのが、Ansible側の`reboot_timeout`と、Terraformを呼び出す外側の環境が持つタイムアウトとの関係を、意識的に揃えておくことです。

```plaintext
reboot_timeoutを、外側のタイムアウト（CI/CDのジョブタイムアウト等）より
十分短く設定する
　→ Ansible側が先にタイムアウトし、明確な失敗として結果が返る
　→ 外側の都合による強制終了で処理が打ち切られる事態を避けられる
```

この対処の考え方は、「どちらのタイムアウトが先に働くか」を偶然に任せず、内側（Ansible）を必ず先に働かせるという順序を、設定の時点で決めておくというものです。外側のタイムアウトが先に働いた場合、Terraformの実行は強制終了という形になり、何が起きていたのかを事後的に追いにくくなります。一方、内側のタイムアウトが先に働けば、`reboot`タスクの失敗という明確な形でAnsible側からエラーが返るため、原因の切り分けがしやすくなります。

### 再起動を伴うタスクを独立したフェーズに分離する

`local-exec`本体の中に`reboot`タスクを含むPlaybook全体を組み込むのではなく、再起動を伴う処理だけを別の`null_resource`に切り出し、独立したプロビジョニングのフェーズとして扱う設計です。

```plaintext
【分離前】
null_resource.provision
　└─ local-exec: 通常のプロビジョニング + rebootタスクを含むPlaybookを一括実行

【分離後】
null_resource.provision
　└─ local-exec: 通常のプロビジョニングのみ実行

null_resource.reboot_phase
　└─ local-exec: rebootタスクを含むPlaybookのみ実行
　　　depends_on = [null_resource.provision]
```

この分離の利点は、再起動に伴う待機時間が、他のプロビジョニング処理の待機時間と混ざらなくなる点にあります。`null_resource.reboot_phase`が失敗した場合、原因が再起動関連の処理にあることが、リソース単位で明確になります。また、再起動フェーズにだけ個別のタイムアウトを設定するといった調整も、フェーズが分かれていれば行いやすくなります。

### local-execにも明示的なタイムアウトを設定する

`local-exec`プロビジョナーには`timeout`引数があり、これを指定することで、`local-exec`自身にも待機の上限を持たせることができます。

```hcl
provisioner "local-exec" {
  command = "ansible-playbook -i inventory.ini reboot_playbook.yml"
  timeout = 700
}
```

この`timeout`を、Ansible側の`reboot_timeout`より少し長い値に設定しておけば、Ansible側が正常にタイムアウトして失敗を返すまでの時間を、`local-exec`側が先回りして打ち切ってしまう事態を避けられます。同時に、外側のCI/CD等が持つタイムアウトよりは短く設定しておくことで、セクション5で整理した「内側を必ず先に働かせる」という順序を、`local-exec`のレベルでも担保できます。

### 3つの対処の関係

ここまでの3つの対処は、いずれも独立した設計判断ではなく、互いに補い合う関係にあります。

|対処|担う役割|
|---|---|
|タイムアウトの整合|内側と外側、どちらが先に働くかの順序を決める|
|フェーズの分離|再起動に伴う待機を、他の処理から切り離す|
|local-execへの明示的なtimeout|Ansible側と外側の間に、中間的な上限を設ける|

いずれも、「`local-exec`は子プロセスの内部状態を関知しない」というセクション4で確認した受動性そのものをなくすものではありません。この受動性を前提としたうえで、待機時間の見積もりと、その見積もりに基づいた上限設定を、意識的に行っておくという対処です。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* Ansibleの`reboot`モジュールは、再起動コマンドの実行、接続切断の検知、`reboot_timeout`内での再接続試行、起動完了確認という一連の流れをモジュール内部で完結させており、通常の実行であれば呼び出し元はこの過程を意識する必要がない
* Terraformの`local-exec`は、起動した`ansible-playbook`の子プロセスが最終的にどう終了するかだけを見ており、その内部で`reboot`タスクが正常に再接続を待っているのか、異常な理由で停止しているのかを区別する手段を持たない。この受動性は、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**・**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** でも共通して現れてきた構造である
* Ansible側が持つ`reboot_timeout`と、Terraformを呼び出す外側の環境が持つタイムアウト（CI/CDのジョブタイムアウト等）は、互いを参照せずに別々に設定されるため、両者の関係がずれると、Ansible側がまだ正常な再試行の範囲内であっても、外側の都合で処理が強制終了させられることがある
* 対処には、内側（Ansible）のタイムアウトを外側より必ず先に働かせるよう値を整合させる方法、再起動を伴うタスクを独立したフェーズに分離する方法、`local-exec`自体に明示的な`timeout`を設定し中間的な上限を設ける方法の3つがあり、いずれも受動性そのものをなくすのではなく、待機時間の見積もりを意識的に行っておくための設計である

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** では、becomeの認証時に、パスワード入力を要求するオプションを指定した場合に限り、非対話実行環境で処理が無応答のまま停止する構造を扱いました。**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** となる今回は、OS再起動という正規の操作が引き起こす接続断絶を、Terraformの`local-exec`がどう受動的に観測するかを整理しました。`reboot_timeout`という明示的な上限を持つ点で第26回のBECOMEパスワード待ちとは異なりますが、子プロセスの内部状態を`local-exec`側が区別できないという構造そのものは共通していることを確認しました。

次回は、対象OSの違いに視点を移します。ここまで扱ってきたSSH接続を前提とした問題から離れ、Windowsターゲット（WinRM）接続時に発生する認証、暗号化エラーという、接続プロトコルの違いに起因する別種の問題を扱います。

**[次回：第28回：異種OS（Windowsターゲット）混在環境における接続プロトコルの制約](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)　｜　[次の記事:【Ansible×Terraform編】第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第3部：トラブルシューティング、デバッグ編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**|統合実行時におけるネストされたエラーログの解析手法|Terraformの`local-exec`経由で実行されたAnsibleのエラーログから、原因がTerraform側（HCL、State）かAnsible側（Playbook、タスク）かを特定する手法。|
|**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)**|マルチネットワーク環境におけるインターフェース競合|複数ネットワーク（Dockerネットワーク等）をアタッチした際、Ansibleの`ansible_default_ipv4`や接続IPの自動検出が意図しないインターフェースに引きずられる問題。|
|**[第23回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)**|大容量ファイル転送、重いタスク実行時におけるSSHタイムアウト|Ansibleで大きなアセットや大量のパッケージを転送、適用する際、Terraform側のプロビジョナータイムアウトに引っかかる可能性がある問題を扱う。|
|**[第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)**|並列実行時における実行ホストのシステムリソース枯渇対策|`parallelism`や`forks`設定により、大量のリソース構築とAnsibleプロビジョニングが同時に走った場合、ホストのCPU、メモリ、ファイルディスクリプタが枯渇しうる問題を扱う。|
|**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)**|構文チェックツール（HCL構文、ansible-lint）の競合緩和|両ツールの静的解析ツール（`terraform fmt`、`ansible-lint`）を導入した際、コード記述ルールや命名規則の不一致でCIが通らなくなる問題。|
|**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**|管理者権限（sudo）実行時におけるパスワード入力のプロンプト停止|Terraformのlocal-exec経由でAnsibleのbecomeを実行する際、パスワード入力を要求するオプションを指定した場合に限り、非対話実行環境で処理が無応答のまま停止する問題。|
|**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**|再起動、再生成に伴うプロビジョニング断絶|AnsibleのrebootモジュールによるOS再起動時、接続断絶が正常な過程か異常な停止かをTerraformのlocal-execが区別できず、外側のタイムアウトと競合する問題。|
|**[第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)**|異種OS（Windowsターゲット）混在環境における接続プロトコルの制約|SSHではなくWinRM等を用いる特殊プロトコル環境での接続、権限エラー。実務でWindows ServerをAnsible×Terraformで管理する際の構造的注意点を扱う概念解説回。|
|**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)**|プロキシ環境等における外部コレクション（Ansible Galaxy）の取得失敗|インフラ構築処理の途中で外部ネットワーク（Ansible Galaxy等）への依存が切れ、Terraformの処理全体が失敗する問題。|
|**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)**|デバッグフラグの組み合わせによるログ解析の高度化|Terraformの`TF_LOG`とAnsibleの`-vvvv`を組み合わせ、接続遅延や処理遅延のボトルネックを特定、解消する手法。|

---

[↑ 目次に戻る](#-目次)

---