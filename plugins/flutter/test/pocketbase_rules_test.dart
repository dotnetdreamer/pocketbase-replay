import 'package:flutter_test/flutter_test.dart';
import 'package:pocketbase_replay_flutter/src/activity/pocketbase_rules.dart';

// The same cases as the web client's test/pocketbase.test.ts, since the server reads calls by the same rules.
void main() {
  test('calls are named by how PocketBase routes them, without query, fragment or control characters', () {
    final cases = <(String, String, Map<String, String>)>[
      ('GET', '/api/collections/posts/records?filter=(title%3D%22secret%22)#x', {'collection': 'posts', 'action': 'list'}),
      ('POST', '/api/collections/posts/records', {'collection': 'posts', 'action': 'create'}),
      ('get', '/api/collections/posts/records/abc123', {'collection': 'posts', 'action': 'view', 'record': 'abc123'}),
      ('PATCH', '/api/collections/posts/records/abc123', {'collection': 'posts', 'action': 'update', 'record': 'abc123'}),
      ('DELETE', '/api/collections/posts/records/abc123', {'collection': 'posts', 'action': 'delete', 'record': 'abc123'}),
      ('POST', '/api/collections/users/auth-with-password', {'collection': 'users', 'action': 'auth-with-password'}),
      ('GET', '/api/collections/users/auth-methods', {'collection': 'users', 'action': 'auth-methods'}),
      ('POST', '/api/collections/_superusers/impersonate/u1', {'collection': '_superusers', 'action': 'impersonate', 'record': 'u1'}),
      ('POST', '/api/batch', {'action': 'batch'}),
      ('POST', '/api/realtime', {'action': 'realtime'}),
      ('POST', '/api/files/token', {'action': 'file-token'}),
      ('PUT', '/api/collections/posts/records', {'collection': 'posts'}),
      ('GET', '/api/collections/bad%20name/records', {}),
      ('GET', '/api/health', {}),
      ('GET', 'api/collections/posts/records/', {'collection': 'posts'}),
    ];
    for (final (method, path, expected) in cases) {
      final call = describeCall(method, path);
      expect(
        {'collection': call.collection, 'action': call.action, 'record': call.record},
        {'collection': expected['collection'], 'action': expected['action'], 'record': expected['record']},
        reason: '$method $path',
      );
      expect(call.path, isNot(matches(RegExp('[?#]|secret'))));
      expect(call.path, startsWith('/'));
    }
    expect(describeCall(null, null).method, 'GET');
    expect(describeCall('GET', '/api/x\u0000y\n').path, '/api/xy');
    expect(describeCall('GET', '/api/${'x' * 400}').path.length, 300);
  });

  test('a list keeps whether it was filtered and which fields it sorted, expanded or picked, never the filter itself', () {
    expect(
      describeQuery({
        'filter': 'email = "alice@example.test"',
        'sort': '-created,title',
        'expand': 'author.profile',
        'fields': 'id,description:excerpt(200,true)',
        'skipTotal': 'true',
        'page': '2',
      }),
      {'filter': true, 'sort': '-created,title', 'expand': 'author.profile', 'fields': 'id,description:excerpt(200,true)', 'skipTotal': true},
    );
    expect(describeQuery({'sort': 'title="secret"', 'expand': 'x' * 201, 'filter': '  '}), {'unreadable': true});
    expect(describeQuery({'sort': 'title="secret"', 'fields': 'id'}), {'unreadable': true, 'fields': 'id'});
    expect(describeQuery({}), isNull);
  });

  test('an answer adds counts and ids only; a sign-in names the account but nothing else', () {
    const list = PocketBaseCall('GET', '/x', collection: 'posts', action: 'list');
    expect(
      describeResult(list, {
        'page': 2,
        'perPage': 30,
        'totalItems': 42,
        'items': [
          {'secret': 'a'},
          {'secret': 'b'},
        ],
      }),
      {'items': 2, 'total': 42, 'page': 2, 'perPage': 30},
    );
    expect(describeResult(const PocketBaseCall('GET', '/x', action: 'list'), {'page': 1, 'perPage': 30, 'totalItems': -1, 'items': []}),
        {'items': 0, 'page': 1, 'perPage': 30});
    expect(describeResult(const PocketBaseCall('POST', '/x', action: 'create'), {'id': 'new123', 'title': 'secret'}), {'record': 'new123'});
    expect(
      describeResult(const PocketBaseCall('POST', '/x', collection: 'users', action: 'auth-with-password'), {
        'token': 'jwt',
        'record': {'id': 'u1', 'email': 'alice@example.test'},
      }),
      {'record': 'u1'},
    );
    expect(describeResult(const PocketBaseCall('GET', '/x', action: 'view'), {'id': 'not an id!'}), isEmpty);
  });

  test('a failure keeps the status and field names and codes, without custom or field error messages', () {
    expect(
      describeFailure(400, {
        'message': 'Failed for alice@example.test and Wonderland',
        'data': {
          'total': {'code': 'validation_required', 'message': 'Cannot be blank.'},
          'email': {'code': 'validation_invalid_email', 'message': 'alice@example.test is invalid'},
          'bad field!': {'code': 'x', 'message': 'y'},
          'nested': {'requests': {}},
          'odd': {'code': 'has space', 'message': 'z'},
        },
      }, [
        'Wonderland',
      ]),
      {
        'status': 400,
        'invalid': [
          {'field': 'total', 'code': 'validation_required'},
          {'field': 'email', 'code': 'validation_invalid_email'},
        ],
      },
    );
    final many = {for (var index = 0; index < 30; index++) 'f$index': {'code': 'validation_required'}};
    expect((describeFailure(400, {'data': many}, const [])['invalid'] as List).length, 20);
    expect(describeFailure(404, 'not json', const []), {'status': 404});
    for (final message in const [
      'Failed to create record.',
      'Failed to update record.',
      'Failed to delete record.',
      "The requested resource wasn't found.",
      'Only superusers can perform this action.',
      'Something went wrong while processing your request.',
      'Failed to authenticate.',
      'Missing or invalid authentication.',
    ]) {
      expect(describeFailure(400, {'message': message}, const [])['message'],
          message);
    }
    expect(
        describeFailure(
            400, {'message': 'Failed to create record. PIN 827461'}, const []),
        {'status': 400});
  });

  test('a batch lists its calls with their statuses and a subscription its collections, never bodies or options', () {
    final body = {
      'requests': [
        {
          'method': 'POST',
          'url': '/api/collections/orders/records?expand=x',
          'body': {'total': 'secret'},
        },
        {'method': 'DELETE', 'url': '/api/collections/orders/records/o1'},
      ],
    };
    expect(describeBatch(body, [
      {
        'status': 200,
        'body': {'secret': 1},
      },
      {'status': 404},
    ]), [
      {'method': 'POST', 'path': '/api/collections/orders/records', 'collection': 'orders', 'action': 'create', 'status': 200},
      {'method': 'DELETE', 'path': '/api/collections/orders/records/o1', 'collection': 'orders', 'action': 'delete', 'record': 'o1', 'status': 404},
    ]);
    expect(describeBatch(body, null).map((item) => item['status']), [0, 0]);
    expect(describeTopics({
      'clientId': 'c1',
      'subscriptions': ['posts/abc?options={"query":{"secret":1}}', 'orders', 'bad name', 'posts'],
    }), ['posts', 'orders']);
  });

  test('the link header carries the session only when it is a recording id', () {
    expect(linkValue('a' * 20, 'b' * 15), '${'a' * 20}.${'b' * 15}');
    expect(linkValue('a' * 20, 'short'), 'a' * 20);
    expect(linkValue('a' * 20, null), 'a' * 20);
    expect(originOf(Uri.parse('https://pb.test:8443/api/x?y')), 'https://pb.test:8443');
    expect(originOf(Uri.parse('flutter://app/x')), '');
  });
}
