---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第31回：状態出力を介した疎結合なパイプライン設計'
description: 'Terraformのlocal-exec経由でAnsibleを直接実行する密結合構成を見直し、Terraformの責務を状態（tfstate・output）の出力に限定する設計を扱う。Ansible側がその出力を独立したタイミングで読み込んで動作する疎結合なパイプライン設計への移行を整理する。'
pubDate: 2026-08-31
category: 'infra'
tags: ['Ansible', 'Terraform', 'output', '疎結合設計', 'local-exec']
seriesId: 'ansible-terraform-part4'
seriesNo: 31
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/'
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
2. [local-exec方式における責務混在の構造（振り返り）](#2-local-exec方式における責務混在の構造振り返り)
3. [tfstateからの動的inventory生成の仕組み](#3-tfstateからの動的inventory生成の仕組み)
4. [実行タイミングの分離による設計変更](#4-実行タイミングの分離による設計変更)
5. [疎結合化によって解消される問題と新たに生じる課題](#5-疎結合化によって解消される問題と新たに生じる課題)
6. [まとめ](#6-まとめ)
7. [次回予告](#7-次回予告)
8. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#8-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「`local-exec`でAnsibleを呼び出しておけば、あとはTerraformが結果を教えてくれる」と考えたことはないでしょうか。

第3部（第21〜30回）は、この`local-exec`経由でAnsibleを実行する構成を前提として、その中で起きる個々のトラブルの原因特定と対処法を扱ってきました。**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** ではAnsible側のエラー情報がTerraformのログの中に埋没する構造を、**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** ではsudoパスワードのプロンプト入力待ちによる無応答停止を、**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** では再起動に伴う接続断絶の扱いを、**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)** では外部コレクションの取得失敗を、それぞれ整理しました。**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)** では、これらの原因特定に使うデバッグフラグの組み合わせを体系化しました。

第4部（第31〜40回）は、この前提そのものを見直します。第3部で扱ってきた個々のトラブルは、性質も現れ方もそれぞれ異なっていました。しかし、その多くは「Terraformのプロセスの中でAnsibleを直接実行する」という同じ構成の上で起きています。**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** となる今回は、その起点として、Terraformの責務を状態（tfstate・output）の出力に限定し、Ansible側がその出力を独立したタイミングで読み込んで動作する、疎結合な設計への移行を扱います。

この回で扱う問いは、「密結合を解消すると、第3部で個別に対処してきた問題群はそれぞれどうなるのか」です。すべてが解消されるのか、それとも別の形の課題に置き換わるだけなのか、この後のセクションで順に整理していきます。

次のセクションでは、この問いの前提となる、`local-exec`方式が抱えていた責務混在の構造を振り返ります。

---

[↑ 目次に戻る](#-目次)

---

## 2. local-exec方式における責務混在の構造（振り返り）

これまでの構成の何が問題だったかを整理します。

Terraformの`local-exec`プロビジョナーは、リソース作成後に任意のコマンドを実行するための機能です。しかし第3部で扱ってきた第1部〜第3部の構成では、この`local-exec`を通じてAnsibleという別ツールの実行そのものを担わせていました。この構造を図で整理します。

```
【local-exec方式（第1部〜第3部の前提）】
Terraformプロセス
　└─ リソース作成
　　　└─ local-exec起動
　　　　　└─ ansible-playbook実行（Terraformプロセスの子プロセスとして）
　　　　　　　├─ Ansible内部のタスク成否
　　　　　　　├─ Ansible内部のログ出力
　　　　　　　└─ Ansible内部のプロンプト、シグナル処理
　　　　　　　　　　↓（すべてが終了コードという単一の値に圧縮される）
Terraformプロセスが観測できる情報：終了コードと標準出力の転送内容のみ
```

Terraformの`local-exec`は、起動した子プロセスの標準出力、標準エラーをそのまま転送し、最終的な終了コードを見て成功、失敗を判定します。子プロセスの内部でどのような処理が進んでいるか、その処理が正常な過程にあるのか異常な状態にあるのかを、`local-exec`自身が区別する手段は持っていません。

この構造が、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**、**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**、**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** でそれぞれ扱った現象の起点になっていました。3回の内容を表で整理します。

|回|現象|責務混在との関係|
|---|---|---|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**|異常終了時、Ansibleの実行結果がTerraformのエラーブロック内に再掲され、同じ内容が2箇所に重複することで失敗箇所が見えにくくなる|`local-exec`は出力を握りつぶしてはいないが、罫線装飾と重複表示によって、標準出力の転送内容から実際の失敗箇所を読み解く必要が生じる|
|**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**|`--ask-become-pass`指定時、sudoパスワードのプロンプトへの応答先が用意されておらず、処理が無応答のまま停止する|子プロセスがプロンプト入力待ちのまま残り続けても、`local-exec`はそれが正常な待機か異常な停止かを区別できず、子プロセスの終了を待ち続ける|
|**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**|`reboot`モジュールによる接続断絶を、`local-exec`が正常な再起動待ちか異常なハングかを区別できない|`reboot`モジュールは接続断絶を再起動に伴う正常な過程として内部で完結させているが、この情報は`local-exec`の外側には伝わらない|

3回に共通しているのは、`local-exec`が「子プロセスの終了」という単一の情報だけを頼りに動作しているという点です。子プロセスの内部で起きている状態遷移や、その状態が正常か異常かという判断材料は、`local-exec`の外側には伝わりません。子プロセスは開始と終了という2つの時点だけを持つブラックボックスであり、その間に何が起きているかは`local-exec`の関知するところではありません。

この受動性は、`local-exec`の実装上の欠陥ではなく、シェルコマンドを起動してその終了を待つという、`local-exec`本来の役割から必然的に導かれる性質です。次のセクションでは、この責務混在を解消する具体的な仕組みとして、tfstateからの動的inventory生成を扱います。

---

[↑ 目次に戻る](#-目次)

---

## 3. tfstateからの動的inventory生成の仕組み

疎結合設計の中核となる仕組みを整理します。

Terraformの責務を「状態を出力するところまで」に限定する場合、Ansible側はTerraformのプロセスの外側から、その出力を読み込んでinventoryを構築する必要があります。ここでは`terraform output -json`と、Ansibleの動的インベントリの仕組みを組み合わせた具体例を示します。

まず、Ansibleが接続に必要とするホスト情報（IPアドレス、ポート）を`output`として定義します。

* **ファイル名：**`outputs.tf`

```hcl
output "target_nodes" {
  value = {
    for name, container in docker_container.targets :
    name => {
      host = container.network_data[0].ip_address
      port = 22
    }
  }
  description = "Ansible接続用のホスト、ポート情報（動的インベントリ用）"
}
```

**実行コマンド**

```plaintext
terraform output -json target_nodes
```

**▼ 実行結果**

```plaintext
{"target-node1":{"host":"172.20.0.4","port":22},"target-node2":{"host":"172.20.0.3","port":22},"target-node3":{"host":"172.20.0.2","port":22}}
```

この出力を読み込んでAnsibleのinventoryを動的に構築するスクリプトを用意します。

* **ファイル名：**`dynamic_inventory.py`

```python
#!/usr/bin/env python3
import json
import subprocess

result = subprocess.run(
    ["terraform", "output", "-json", "target_nodes"],
    capture_output=True, text=True, cwd="/home/control/iac/docker-lab"
)
nodes = json.loads(result.stdout)

inventory = {
    "target_nodes": {
        "hosts": list(nodes.keys())
    },
    "_meta": {
        "hostvars": {
            name: {
                "ansible_host": v["host"],
                "ansible_port": v["port"],
                "ansible_user": "ansible"
            }
            for name, v in nodes.items()
        }
    }
}
print(json.dumps(inventory))
```

Ansibleの動的インベントリスクリプトは、Ansible側から実行可能なファイルとして認識される必要があるため、実行権限を付与します。

**実行コマンド**

```plaintext
chmod +x dynamic_inventory.py
```

このスクリプト単体を実行し、想定通りのインベントリ形式が出力されるかを確認します。

**実行コマンド**

```plaintext
python3 dynamic_inventory.py
```

**▼ 実行結果**

```plaintext
{"target_nodes": {"hosts": ["target-node1", "target-node2", "target-node3"]}, "_meta": {"hostvars": {"target-node1": {"ansible_host": "172.20.0.4", "ansible_port": 22, "ansible_user": "ansible"}, "target-node2": {"ansible_host": "172.20.0.3", "ansible_port": 22, "ansible_user": "ansible"}, "target-node3": {"ansible_host": "172.20.0.2", "ansible_port": 22, "ansible_user": "ansible"}}}}
```

最後に、この動的インベントリを使って、`local-exec`を一切経由せずに`ansible-playbook`を直接実行します。

**実行コマンド**

```plaintext
ansible-playbook -i dynamic_inventory.py ../ansible/playbooks/test_nested_normal.yml
```

**▼ 実行結果**

```plaintext
PLAY [local-execログ構造デモ（正常系）] *****************************************************************************************************************************************************
TASK [検証用ディレクトリを作成する] *********************************************************************************************************************************************************
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
changed: [target-node1]
TASK [検証用設定ファイルを配置する] *********************************************************************************************************************************************************
changed: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

`target-node1`に対する2つのタスクがいずれも`changed`で完了し、`failed=0`という結果になりました。この実行では、`terraform apply`は一切呼び出されていません。`terraform output -json target_nodes`の結果を`dynamic_inventory.py`が読み込み、それをもとに`ansible-playbook`が直接ターゲットホストへ接続しています。

ポイントは、このスクリプトの実行タイミングがTerraformのプロセスとは完全に独立している点です。`terraform apply`が完了した後であれば、任意のタイミング、任意のプロセスからこのスクリプトを呼び出せます。実際、今回の実行は`terraform apply`が完了してから時間をおいて、別のコマンドとして起動しています。

---

[↑ 目次に戻る](#-目次)

---

## 4. 実行タイミングの分離による設計変更

分離によって何が変わるかを整理します。

`local-exec`方式では`terraform apply`の中でAnsible実行が完了するまでTerraformプロセスが待機していましたが、疎結合方式では`terraform apply`はリソース作成と`output`の出力のみで完了し、Ansible実行は別プロセス、別タイミングで行われます。セクション3で確認した通り、`dynamic_inventory.py`は`terraform apply`の完了後、任意のタイミングで独立して呼び出せます。この違いを図で整理します。

```
【local-exec方式】
terraform apply実行
　└─ リソース作成 → local-exec起動 → Ansible実行完了を待機 → apply完了

【疎結合方式】
terraform apply実行
　└─ リソース作成 → output出力 → apply完了（ここでTerraformプロセスは終了）

（別プロセス、別タイミング）
ansible-playbook -i dynamic_inventory.py site.yml 実行
```

この分離によって、**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**、**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** で扱った現象がどう変わるかを整理します。

**sudoプロンプト停止（[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)）**

**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** で確認した無応答停止は、`--ask-become-pass`によるプロンプトへの応答先が、`local-exec`経由の実行では用意されていないことが原因でした。疎結合方式では、`ansible-playbook`はTerraformの子プロセスとしてではなく、実行者自身が直接起動する独立したプロセスになります。手元の端末から実行する場合、この端末はプロンプトへの入力を受け付けられる状態にあるため、**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** のセクション3で確認した「手元端末から直接実行した場合」と同じ状況になり、標準入力の接続問題自体が発生しなくなります。ただし、CI環境のような非対話実行の場面で`--ask-become-pass`を使う場合は、応答先が用意されていないという条件自体は変わらないため、NOPASSWD設定やAnsible Vaultといった、**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** で整理した対策は引き続き必要です。

**reboot切断誤認（[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)）**

**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** で整理した問題は、`reboot`モジュールが接続断絶を正常な過程として扱っていても、`local-exec`側はその情報を受け取れず、子プロセスが応答しない状態が続いているという事実だけを観測する、という構造でした。疎結合方式では、Ansible実行そのものがTerraformのプロセスから切り離されるため、Terraformが`reboot`タスクの実行中に何かを監視するという状況自体がなくなります。`terraform apply`はリソース作成とoutputの出力の時点ですでに完了しており、その後で行われる`reboot`タスクを含むAnsible実行を、Terraformは観測する立場にありません。「Terraformから見た異常」という現象そのものが発生しなくなります。ただし、`reboot`モジュール自身の`reboot_timeout`や再接続の待機処理は、Ansible単体の実行として引き続き必要であり、この部分の設計自体が不要になるわけではありません。

**共通する変化**

いずれの場合も、変わるのは「Terraformがそれを観測する立場にあるかどうか」という点であり、Ansible内部の処理そのものが変わるわけではありません。**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)** のBECOMEパスワード処理も、**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** の再接続処理も、Ansible単体の責務としては変わらず存在し続けます。疎結合化によって解消されるのは、あくまで「`local-exec`がAnsibleの内部状態を区別できないことに起因する問題」であり、Ansible自体の設計課題まで消えるわけではない、という点は次のセクションで改めて整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. 疎結合化によって解消される問題と新たに生じる課題

この設計変更のトレードオフを整理します。

疎結合化によって解消される問題と、形を変えて残る、あるいは新たに生じる問題を対比します。

|区分|内容|
|---|---|
|解消される|標準入力の接続問題に起因するsudoプロンプト停止（**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**）|
|解消される|Terraformがreboot時の接続断を異常として誤認する状況そのもの（**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**）|
|形を変えて残る|Ansible内部の失敗箇所の視認性（**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**）は、Terraformのエラーブロックへの重複表示がなくなる一方、Ansible単体の出力を読み解く必要性自体は残る|
|解消されない|Ansible Galaxyからの依存関係取得失敗（**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)**）は、`ansible-galaxy`コマンド自体がプロキシ環境に到達できないことが原因であり、`local-exec`経由か独立実行かに関わらず変わらず発生する|
|新たに生じる|Terraform applyの完了とAnsible実行の間の実行順序、タイミングをどう保証するか、という設計課題|

**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**、**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** の2回は、セクション4で整理した通り、「TerraformがAnsibleの内部状態を観測する立場にあること」自体が問題の起点でした。疎結合化によってこの観測の立場そのものがなくなるため、いずれも状況として発生しなくなります。

一方、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** の問題は、性質がやや異なります。**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** で確認した通り、`local-exec`は失敗したAnsibleの出力を握りつぶしているわけではなく、`Error: local-exec provisioner error`ブロックの`Output:`以降に同じ内容が再掲されることで、視認しにくくなるという問題でした。疎結合化すれば、この重複表示、罫線装飾という視認性を下げていた要因自体はなくなります。しかし、Ansible単体の実行結果を読み、どのタスクが失敗したかを特定するという作業そのものは、疎結合化した後も変わらず必要です。問題が完全に消えるのではなく、Terraform由来の視認性の低下要因が取り除かれる、という形での変化にあたります。

**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)** の問題は、疎結合化によっても解消されません。**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)** で確認した`Connection refused`は、`ansible-galaxy collection install`というコマンド自体が外部ネットワークに到達できないことが原因であり、このコマンドを`local-exec`経由で呼び出しているか、独立したプロセスから呼び出しているかは無関係です。疎結合化はTerraformとAnsibleの実行タイミングの関係を変える設計であり、Ansible自身が抱える依存関係取得の問題には影響しません。

最後に、新たに生じる課題について整理します。`local-exec`方式では、Terraform applyが完了した時点でAnsibleの実行も完了していることが、プロセスの構造上保証されていました。疎結合方式ではこの保証がなくなり、`terraform apply`の完了とAnsible実行の間には、何らかの形で実行順序を管理する仕組みが必要になります。この時点では手動実行（`terraform apply`の後に手動でansible-playbookを実行する運用）を前提とすると、実行順序の保証は実質的に実行者の注意力に依存してしまいます。この課題への対処が、次回以降のCI/CDパイプライン設計につながります。

---

[↑ 目次に戻る](#-目次)

---

## 6. まとめ

この回で整理した内容を確認します。

* `local-exec`方式では、Terraformのプロセスが「リソース作成」と「Ansible実行の待機、結果受信」という異なる性質の処理を同一プロセス内で担っていた。この責務混在が、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**、**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**、**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** で扱った問題の共通の起点になっていた
* `terraform output -json`とAnsibleの動的インベントリの仕組みを組み合わせることで、Terraformは状態の出力に専念し、Ansibleがそれをプロセスの外側から独立して読み込むという疎結合設計が実現できる。この構成は、Terraformの`local-exec`を一切経由せずに`ansible-playbook`を実行できることを、実機で確認した
* 疎結合化によって、Terraformがその内部状態を観測する立場にあること自体が問題の起点だった **[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**、**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** の問題は、状況として発生しなくなる
* **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** の視認性の問題は、Terraform由来の重複表示という要因は取り除かれるものの、Ansible単体の出力を読み解く作業自体は残る。**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)** の依存関係取得失敗は、`ansible-galaxy`コマンド自体の問題であるため、疎結合化によっても解消されない
* 疎結合化によって、TerraformとAnsibleの実行順序をどう保証するかという新しい設計課題が生じる。手動実行を前提とする限り、この保証は実行者の注意力に依存してしまう
* 疎結合にすること自体がゴールではない。解消される問題と、形を変えて残る、あるいは新たに生じる問題があり、トレードオフとして捉える必要がある

---

[↑ 目次に戻る](#-目次)

---

## 7. 次回予告

**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)** では、第3部の最終回として、`TF_LOG`と`-vvvv`という2つのデバッグフラグの体系化を扱いました。**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** となる今回は、第4部の起点として、Terraformの`local-exec`経由でAnsibleを直接実行する密結合構成を見直し、Terraformの責務を状態の出力に限定する疎結合設計への移行を扱いました。`terraform output -json`と動的インベントリスクリプトを組み合わせることで、Terraformのプロセスから完全に独立してAnsibleを実行できることを、実機検証を交えて確認しました。

次回は、この疎結合化によって生じた「実行順序をどう保証するか」という課題に対し、GitHub Actionsを用いたCI環境の構築によって、コードのプッシュをトリガーとしたTerraformとansible-lintの静的検証を自動実行する仕組みを扱います。

**[次回：第32回：GitHub Actionsを用いたプロビジョニングコードの自動テスト環境構築](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)　｜　[次の記事：【Ansible×Terraform編】第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 8. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第4部：改善、CI/CD自動化編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)**|状態出力を介した疎結合なパイプライン設計|Terraformの`output`を中間データ（JSON/Environment）として抽出し、Ansibleの動的インベントリや変数として渡すパイプラインの分離設計。|
|**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)**|GitHub Actionsを用いたプロビジョニングコードの自動テスト環境構築|CI/CD（GitHub Actions）上でTerraform実行によるコンテナ起動からAnsible適用までの自動テスト（E2E）を組み込む手法。|
|**[第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)**|`triggers`を用いたAnsible再実行の最適化設計|`null_resource`や`terraform_data`の`triggers`／`triggers_replace`を使い、設定ファイル変更時のみAnsibleを発火させる設計。|
|**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)**|Testinfraによる状態検証を組込んだCI/CDパイプライン|Ansible適用後の状態（ポート、ファイル、プロセス）をTestinfra（Python）でテストし、パイプラインの成否を判定する自動化設計。|
|**[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)**|共通パーツのモジュール化（Terraformモジュール／Ansibleロール）|Terraformのモジュール設計とAnsibleのロール（Role/Collection）の粒度を揃え、再利用性を高める設計パターン。|
|**[第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)**|プラグインおよびパッケージのキャッシュによる開発効率の向上|Terraformのプラグインキャッシュとaptパッケージキャッシュにより、検証サイクルの待ち時間を短縮する手法。|
|**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)**|定期実行による構成ドリフトの自動検知と収束パイプライン|スケジュール実行（Cron／GitHub Actions）で`ansible-playbook --check`を流し、実際の構成差分（ドリフト）を検知し、差分があった場合のみ本実行して自動収束させる設計。|
|**[第38回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/)**|インフラコード（HCL／Playbook）からの仕様書、構成図の自動生成|`terraform-docs`や`ansible-autodoc`等を活用し、コード更新と同時に仕様書や依存関係図を自動更新するパイプライン構築。|
|**[第39回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/)**|既存インフラ運用知識とInfrastructure as Code（IaC）のシナジー|手動運用（CLI/Shell）のノウハウを、TerraformとAnsibleという2大ツールにどう分解、再構築していくかの比較考察。|
|**[第40回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/)**|改善、CI/CD編まとめ：プロビジョニング自動化の成熟度モデル|手動実行から状態連携、CI/CD化、自動収束（Level 1〜4）に至るまでのインフラ自動化の成熟度の整理。|                                              |

---

[↑ 目次に戻る](#-目次)

---

