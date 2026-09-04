---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第37回：定期実行による構成ドリフトの自動検知と収束パイプライン'
description: 'Ansible Playbookの--checkモードを定期実行し、terraform planでは検知できないコンテナ内部の構成ドリフトを検知、自動収束させるパイプライン設計を整理する。'
pubDate: 2026-09-06
category: 'infra'
tags: ['Ansible', 'Terraform', 'ドリフト検知', 'CI/CD', 'GitHub Actions']
seriesId: 'ansible-terraform-part4'
seriesNo: 37
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/'
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
2. [手動改ざんによるドリフトの発生](#2-手動改ざんによるドリフトの発生)
3. [terraform planが検知できる範囲の限界](#3-terraform-planが検知できる範囲の限界)
4. [ansible-playbook --checkによる構成差分の検知](#4-ansible-playbook---checkによる構成差分の検知)
5. [スケジュール実行の構成](#5-スケジュール実行の構成)
6. [検知結果に応じた自動収束](#6-検知結果に応じた自動収束)
7. [検知レイヤーの整理](#7-検知レイヤーの整理)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#10-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

`terraform plan`が「No changes」と表示していても、実際のインフラは変化していることがあります。

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** から **[第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)** では、実行順序の疎結合化、CI上でのE2E自動化、実行抑制、状態検証、コード共通化、キャッシュという、パイプラインの個々の工程を改善してきました。これらはいずれも、人間が`terraform apply`や`ansible-playbook`を能動的に実行することを前提にしていました。

第37回となる今回は、この前提を見直します。変化が起きたことに人間が気づいて初めて対処する、という運用には限界があります。この回では、`ansible-playbook --check`を定期的に実行して構成差分を検知し、差分があった場合のみ本実行して自動収束させる設計を扱います。

問いは、「`terraform plan`と`ansible-playbook --check`は、それぞれ何を検知でき、何を検知できないのか」です。

次のセクションでは、この回で扱う手動改ざんのシナリオを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 手動改ざんによるドリフトの発生

この回で扱うシナリオの前提を示します。

`docker exec`でtarget-node1に直接接続し、Ansibleの`common_setup`ロールが配布した設定ファイルを、Ansibleを経由せず直接書き換えます。

### ■ 検証内容：`docker exec`によるプロキシ設定ファイルの手動改ざん

改ざん前の状態を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "cat /etc/apt/apt.conf.d/02proxy"
```

**▼ 実行結果**

```plaintext
Acquire::http::Proxy "http://172.20.0.1:3142";
```

`/etc/apt/apt.conf.d/02proxy`のプロキシ先ポート番号を書き換えます。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "sed -i 's/3142/9999/' /etc/apt/apt.conf.d/02proxy"
```

改ざん後の内容を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "cat /etc/apt/apt.conf.d/02proxy"
```

**▼ 実行結果**

```plaintext
Acquire::http::Proxy "http://172.20.0.1:9999";
```

### ■ 結果

プロキシ先のポート番号が`3142`から`9999`に書き換わりました。この変更は、Ansibleを経由せずコンテナ内部に直接加えられたものです。

```
【この変更が記録される場所】
tfstate → 記録されない（Terraformの管理範囲外）
triggers（第33回） → 記録されない（rolesディレクトリ配下のファイル自体は変更されていないため）
コンテナ内部の実際の状態 → 変更されている
```

次のセクションでは、この変更に対して`terraform plan`を実行し、実際に検知されるかどうかを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 3. `terraform plan`が検知できる範囲の限界

この回の核心となる区別を示します。

2節で加えた手動改ざんに対して、実際に`terraform plan`を実行します。

### ■ 検証内容：改ざん後における`terraform plan`・`terraform state list`の確認

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
No changes. Your infrastructure matches the configuration.
Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
```

**実行コマンド**

```plaintext
terraform state list
```

**▼ 実行結果**

```plaintext
docker_container.targets["target-node1"]
docker_container.targets["target-node2"]
docker_container.targets["target-node3"]
docker_network.app_net
docker_network.lab_net
local_file.ansible_inventory
local_file.group_vars_target_nodes
local_file.private_key
null_resource.fix_permission
null_resource.provision
tls_private_key.generated
module.image_ansible_target.docker_image.this
module.image_deploy_nopasswd.docker_image.this
module.image_deploy_passwd.docker_image.this
module.image_legacy.docker_image.this
```

### ■ 結果

`terraform plan`は「No changes」となり、`terraform state list`にも変化はありませんでした。プロキシ先のポート番号を`3142`から`9999`へ書き換えるという実際の変更が、Terraform側からは一切検知されていません。

```
Terraformが管理しているもの：
　docker_container.targetsのイメージ・ポート・環境変数等の「定義」

Terraformが管理していないもの：
　コンテナ内部のファイル・プロセス・設定内容
```

`terraform plan`は、あくまでTerraformの`resource`ブロックに書かれた属性とtfstateの差分を比較する仕組みです。コンテナ内部のファイルに何が書かれているかは、そもそも検知範囲に含まれていません。この結果は「問題がない」ことを意味するのではなく、「Terraformの検知範囲の外側で変更が起きている」ことを意味します。

次のセクションでは、この変更を実際に検知できる仕組みを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 4. `ansible-playbook --check`による構成差分の検知

実際に差分を検知できる仕組みを示します。

`--check`オプションを付けてAnsible Playbookを実行すると、実際には変更を適用せず、対象の現在の状態とPlaybookの内容を比較した結果のみを報告します。`--diff`オプションを併用すると、変更前後の具体的な差分内容も表示されます。

### ■ 検証内容：改ざん後における`ansible-playbook --check --diff`の実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini site.yml --check --diff
```

**▼ 実行結果**

```plaintext
PLAY [接続確認用Playbook] *******************************************************************************************************************************************************************

TASK [common : 疎通確認（common role・第35回更新）] *****************************************************************************************************************************************
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node1]
[WARNING]: Platform linux on host target-node2 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node2]
[WARNING]: Platform linux on host target-node3 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node3]

TASK [common_setup : apt-cacher-ng経由でaptパッケージを取得するようプロキシを設定] **********************************************************************************************************
ok: [target-node2]
ok: [target-node3]
--- before: /etc/apt/apt.conf.d/02proxy
+++ after: /etc/apt/apt.conf.d/02proxy
@@ -1 +1 @@
-Acquire::http::Proxy "http://172.20.0.1:9999";
\ No newline at end of file
+Acquire::http::Proxy "http://172.20.0.1:3142";
\ No newline at end of file
changed: [target-node1]

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

target-node1のみ`changed=1`として検知されました。`--diff`により、改ざん後の内容（`9999`）から本来の内容（`3142`）への差分が具体的に表示されています。改ざんを加えていないtarget-node2・target-node3は`changed=0`のままです。

`terraform plan`では検知できなかった変更が、`ansible-playbook --check`では対象に実際に接続して現在の状態を確認するため、明確に検知されています。target-node1の`02proxy`は改ざんされたままの状態を維持し、次のセクションで扱う定期実行・自動収束の検証に引き継ぎます。

---

[↑ 目次に戻る](#-目次)

---

## 5. スケジュール実行の構成

定期実行の仕組みを示します。

GitHub Actionsの`schedule`トリガーを用いて、target-node1〜3の構成差分を定期的に検知するワークフローを構築します。**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** で作成した`e2e-provisioning-test.yml`とは別に、ドリフト検知専用の新規ワークフロー`drift-check.yml`を用意します。

* **ファイル名：`.github/workflows/drift-check.yml`（新規作成）**

```yaml
name: Drift Check
on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:
jobs:
  drift-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - name: Terraform Init
        run: terraform init
      - name: Terraform Apply
        env:
          TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
          TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
        run: terraform apply -auto-approve
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Install Ansible
        run: pip install ansible
      - name: Set executable permission for dynamic inventory
        run: chmod +x dynamic_inventory.py
      - name: Run Ansible Playbook (initial provisioning)
        run: ansible-playbook -i dynamic_inventory.py site.yml
      - name: Simulate manual tampering
        run: |
          ssh -o StrictHostKeyChecking=no -i ./id_ed25519_generated -p 2231 ansible@127.0.0.1 \
            "sudo sed -i 's/ansible-drift-check/tampered/' /etc/drift-check-target.conf"
      - name: Ansible Check Mode
        id: check
        run: |
          ansible-playbook -i dynamic_inventory.py site.yml --check | tee check_result.txt
          CHANGED=$(grep -oP 'changed=\K[0-9]+' check_result.txt | tail -1)
          echo "changed=$CHANGED" >> "$GITHUB_OUTPUT"
```

このワークフローは、`terraform apply`によるコンテナ起動から初回のAnsible適用までを行ったうえで、`Simulate manual tampering`ステップでSSH経由の直接操作により、Ansibleが管理する設定ファイル（`/etc/drift-check-target.conf`）の内容を意図的に書き換えます。続く`Ansible Check Mode`ステップで、`ansible-playbook --check`を実行し、その結果から`changed`数を抽出して後続ステップに渡します。

GitHub Actionsのホスト型ランナーは実行のたびに使い捨てられるため、常時起動しているインフラを外部から監視する構成にはできません。この検証環境では、コンテナの起動から改ざんの注入、検知までを1回のワークフロー実行内で完結させる構成としています。

### ■ 検証内容：`workflow_dispatch`によるワークフローの動作確認

`Run workflow`によりワークフローを手動実行します。

**▼ 実行結果（Simulate manual tampering）**

```plaintext
Run ssh -o StrictHostKeyChecking=no -i ./id_ed25519_generated -p 2231 ansible@127.0.0.1 \
Warning: Permanently added '[127.0.0.1]:2231' (ED25519) to the list of known hosts.
```

**▼ 実行結果（Ansible Check Mode）**

```plaintext
Run ansible-playbook -i dynamic_inventory.py site.yml --check | tee check_result.txt

PLAY [接続確認用Playbook] ******************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
[WARNING]: Host 'target-node1' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
[WARNING]: Host 'target-node3' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
[WARNING]: Host 'target-node2' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
changed: [target-node1]
ok: [target-node3]
ok: [target-node2]

TASK [疎通確認] ****************************************************************
ok: [target-node2]
ok: [target-node3]
ok: [target-node1]

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

（注）このログはGitHub Actionsのランナー上で`pip install ansible`により取得した最新版で実行されているため、ansible-coreのバージョンがローカル環境（2.17系）とは異なり、警告文言中のドキュメントURLも`2.21`系になっています。

### ■ 結果

CI環境でも、target-node1のみ`changed=1`として検知されました。ローカル環境（2節〜4節）で確認した`terraform plan`・`ansible-playbook --check`それぞれの検知範囲の違いが、GitHub Actions上でも同様に再現されています。

あわせて、cronによるローカル定期実行の代替案も示します。

* **ファイル名：`crontab`（該当箇所）**

```plaintext
0 * * * * cd ~/iac/docker-lab && ansible-playbook -i inventory.ini site.yml --check | tee -a logs/drift-check.log
```

---

[↑ 目次に戻る](#-目次)

---

## 6. 検知結果に応じた自動収束

条件分岐による自動収束を示します。

5節のワークフローに、`changed`数が0より大きい場合のみ本実行するステップを追加します。あわせて、動作確認のため`workflow_dispatch`の入力パラメータで改ざんの注入有無を切り替えられるようにします。

* **ファイル名：`.github/workflows/drift-check.yml`（該当箇所）**

**【変更前】**

```yaml
on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:
```

**【変更後】**

```yaml
on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:
    inputs:
      simulate_tampering:
        description: '改ざんを注入するか'
        type: boolean
        default: true
```

```yaml
      - name: Simulate manual tampering
        if: github.event.inputs.simulate_tampering != 'false'
        run: |
          ssh -o StrictHostKeyChecking=no -i ./id_ed25519_generated -p 2231 ansible@127.0.0.1 \
            "sudo sed -i 's/ansible-drift-check/tampered/' /etc/drift-check-target.conf"
      - name: Ansible Check Mode
        id: check
        run: |
          ansible-playbook -i dynamic_inventory.py site.yml --check | tee check_result.txt
          CHANGED=$(grep -oP 'changed=\K[0-9]+' check_result.txt | paste -sd+ -)
          CHANGED=$((CHANGED))
          echo "changed=$CHANGED" >> "$GITHUB_OUTPUT"
      - name: Apply if drift detected
        if: steps.check.outputs.changed != '0'
        run: ansible-playbook -i dynamic_inventory.py site.yml
```

`changed`の抽出には`grep -oP 'changed=\K[0-9]+' check_result.txt`を用いていますが、`PLAY RECAP`にはノードの数だけ`changed=`の行が出力されるため、単純に末尾1行だけを取り出す方法では、末尾以外のノードで発生した`changed`を見落とします。すべてのノードの値を合算する方式に変更しています。

### ■ 検証内容：改ざんの有無による本実行ステップの分岐確認

改ざんを注入しない状態（`simulate_tampering`をfalseに指定）でワークフローを手動実行します。

**▼ 実行結果（Ansible Check Mode、改ざんなし）**

```plaintext
PLAY [接続確認用Playbook] ******************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
[WARNING]: Host 'target-node3' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
[WARNING]: Host 'target-node2' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
[WARNING]: Host 'target-node1' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node3]
ok: [target-node2]
ok: [target-node1]

TASK [疎通確認] ****************************************************************
ok: [target-node2]
ok: [target-node1]
ok: [target-node3]

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

`changed`の合計値が0となり、`Apply if drift detected`ステップはスキップされました。

続けて、改ざんを注入する状態（`simulate_tampering`をtrueに指定、デフォルト）でワークフローを再実行します。

**▼ 実行結果（Ansible Check Mode、改ざんあり）**

```plaintext
PLAY [接続確認用Playbook] ******************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
[WARNING]: Host 'target-node1' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
[WARNING]: Host 'target-node2' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
[WARNING]: Host 'target-node3' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
changed: [target-node1]
ok: [target-node2]
ok: [target-node3]

TASK [疎通確認] ****************************************************************
ok: [target-node3]
ok: [target-node1]
ok: [target-node2]

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

target-node1のみ`changed=1`として検知され、`changed`の合計値が0より大きくなったことで、`Apply if drift detected`ステップが実行されました。

**▼ 実行結果（Apply if drift detected）**

```plaintext
PLAY [接続確認用Playbook] ******************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] *******************
[WARNING]: Host 'target-node1' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
[WARNING]: Host 'target-node2' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
[WARNING]: Host 'target-node3' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
changed: [target-node1]
ok: [target-node2]
ok: [target-node3]

TASK [疎通確認] ****************************************************************
ok: [target-node3]
ok: [target-node1]
ok: [target-node2]

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

改ざんがない場合は`changed`の合計が0となり、本実行ステップはスキップされました。改ざんがある場合は`changed`の合計が0より大きくなり、本実行ステップが実行され、target-node1の設定ファイルが本来の内容へ収束しました。検知結果に応じて本実行の要否を条件分岐させ、手動改ざんを自動収束させる一連の流れが実機で確認できました。

---

[↑ 目次に戻る](#-目次)

---

## 7. 検知レイヤーの整理

この回で扱った内容と、これまでの回との関係を整理します。

`terraform plan`・`ansible-playbook --check`・**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)** のTestinfraが、それぞれ異なる対象を検知している構造を表で整理します。

|検知手段|検知する対象|検知できないもの|
|---|---|---|
|`terraform plan`|Terraformが管理するリソース定義（イメージ・ポート等）とtfstateの差分|コンテナ内部のファイル・プロセス状態|
|`ansible-playbook --check`|Playbookの内容と対象の実際の状態との差分|Playbookが関知しない領域の変更|
|Testinfra（**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)**）|Ansibleの実行結果とは独立した経路での、タスクが依拠する前提条件（パッケージ・サービスの状態等）の確認|Ansible実行前の状態との比較（あくまで現在の状態のスナップショット確認）|

セクション3で確認した通り、`terraform plan`は`02proxy`の改ざんを検知できませんでした。セクション4で確認した通り、`ansible-playbook --check`はこの改ざんを`changed`として明確に検知しました。**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)** のTestinfraは、これらとは異なるレイヤーを見ています。Ansibleが実行するタスクの成否ではなく、そのタスクが依拠している前提条件（`openssh-server`のインストール状態、`ssh`サービスの起動状態）を、Ansibleの実行結果とは独立した経路（Docker APIまたはSSH）で確認する仕組みでした。

これら3つは代替関係ではなく、それぞれ異なるレイヤーを検知する補完関係にあります。第37回で扱った`--check`による定期検知は、あくまで「Playbookが管理している範囲」の差分検知であり、Playbook自体が把握していない構成要素（例えばAnsibleが一切関与していないミドルウェア）のドリフトまでは検知できない限界があります。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

* `docker exec`による手動改ざんは、Terraformの管理範囲外で発生する構成ドリフトである
* `terraform plan`はTerraformが管理するリソース定義の差分にとどまり、コンテナ内部の構成変更までは検知できないことを実機で確認した
* `ansible-playbook --check`は対象に実際に接続し、Playbookの内容と現在の状態との差分を機械的に検知できることを実機で確認した
* GitHub Actionsの`schedule`トリガーまたはcronによって、この検知を定期実行できる
* 検知結果（`changed`数）に応じて本実行を条件分岐させることで、手動改ざんの自動収束が実現できることを実機で確認した
* `terraform plan`・`ansible-playbook --check`・Testinfraはそれぞれ異なるレイヤーを検知する補完関係にあり、代替関係ではない

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** から **[第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)** では、実行順序の疎結合化、CI上でのE2E自動化、実行抑制、状態検証、コード共通化、キャッシュという、パイプラインの個々の工程を改善してきました。第37回となる今回は、変化の検知と対応の実行を定期的なスケジュールに委ねる設計を扱いました。`docker exec`による手動改ざんに対し、`terraform plan`では検知できないこと、`ansible-playbook --check`であれば構成差分として検知できることを実機で確認したうえで、GitHub Actionsの`schedule`トリガーによる定期検知と、検知結果に応じた自動収束の一連の流れを実機検証しました。

次回は、`terraform-docs`等を用いたインフラ構成コードからの仕様書・構成図の自動生成手法を扱います。

**[次回：第38回：インフラコード（HCL／Playbook）からの仕様書、構成図の自動生成](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)　｜　[次の記事：【Ansible×Terraform編】第38回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 10. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

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
|**[第40回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/)**|改善、CI/CD編まとめ：プロビジョニング自動化の成熟度モデル|手動実行から状態連携、CI/CD化、自動収束（Level 1〜4）に至るまでのインフラ自動化の成熟度の整理。|

---

[↑ 目次に戻る](#-目次)

---