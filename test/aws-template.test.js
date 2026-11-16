const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AWS = require('../src/lib/cloud/aws.js');
const G = require('../src/lib/cloud/guides.js');

const TEMPLATE_PATH = path.join(__dirname, '..', 'aws', 'readonly-cost-user.json');
const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
const resources = Object.values(template.Resources || {});

test('template makes exactly one IAM user and nothing else', () => {
  assert.equal(template.AWSTemplateFormatVersion, '2010-09-09');
  assert.deepEqual(resources.map((r) => r.Type), ['AWS::IAM::User']);
});

test('the user can only call ce:GetCostAndUsage', () => {
  const user = resources[0].Properties;
  assert.equal(user.Policies.length, 1);
  assert.deepEqual(user.Policies[0].PolicyDocument, AWS.POLICY, '확장이 안내하는 정책과 같아야 해요');
  for (const s of user.Policies[0].PolicyDocument.Statement) {
    assert.equal(s.Effect, 'Allow');
    assert.deepEqual(s.Action, ['ce:GetCostAndUsage']);
    assert.equal(s.NotAction, undefined);
    assert.equal(s.NotResource, undefined);
  }
  for (const key of ['ManagedPolicyArns', 'Groups', 'LoginProfile']) {
    assert.equal(user[key], undefined, `${key}로 다른 권한·콘솔 로그인이 붙으면 안 돼요`);
  }
});

test('no access key is created and no secret reaches the stack outputs', () => {
  const text = JSON.stringify(template);
  assert.doesNotMatch(text, /AWS::IAM::AccessKey/);
  assert.doesNotMatch(text, /SecretAccessKey/);
  assert.doesNotMatch(JSON.stringify(template.Outputs || {}), /Fn::GetAtt/, '출력은 사용자 이름 같은 공개 값만');
});

test('the guide offers the same template file the extension ships', () => {
  const file = G.guideFor('aws').steps.flat().find((p) => p.file);
  assert.ok(file, '템플릿 받기 조각이 있어야 해요');
  assert.equal(path.join(__dirname, '..', file.file), TEMPLATE_PATH);
});
