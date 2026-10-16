import 'package:flutter/material.dart';
import 'package:pocketbase/pocketbase.dart';
import 'package:pocketbase_replay_flutter/pocketbase_replay_flutter.dart';

// flutter run --dart-define=REPLAY_ENDPOINT=https://replay.example.com
const String endpoint = String.fromEnvironment('REPLAY_ENDPOINT', defaultValue: 'http://127.0.0.1:8090');

// The app's own PocketBase, here the same server. Its calls appear in the recording.
final PocketBase pb = PocketBase(endpoint, httpClientFactory: ReplayPocketBaseClient.new);

Future<void> main() => PocketBaseReplay.runZoned(() async {
      await PocketBaseReplay.start(PocketBaseReplayOptions(
        endpoint: endpoint,
        metadata: () => ReplayMetadata(
          // Use a stable ID your app stores on the device.
          deviceId: 'example-device',
          appVersion: '1.0.0',
          accountId: pb.authStore.record?.id ?? '',
          authToken: pb.authStore.token,
        ),
        errors: const ErrorTrackingOptions(captureUnhandled: true),
        logs: const LogCaptureOptions(capturePrint: true),
        service: 'example',
      ));
      runApp(const PocketBaseReplayWidget(child: ExampleApp()));
    });

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'PocketBase Replay',
        navigatorObservers: [PocketBaseReplay.navigatorObserver],
        routes: {'/checkout': (_) => const CheckoutPage()},
        home: const HomePage(),
      );
}

class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Shop')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          // Private on screen: painted over in recordings.
          const ReplayMask(child: Text('Balance: 1,250.00')),
          const SizedBox(height: 16),
          FilledButton(onPressed: () => Navigator.pushNamed(context, '/checkout'), child: const Text('Checkout')),
          const SizedBox(height: 16),
          OutlinedButton(
            onPressed: () async {
              final session = await PocketBaseReplay.trigger('report');
              PocketBaseReplay.captureLog(LogLevel.info, 'Problem reported', attributes: {'recorded': session != null});
            },
            child: const Text('Report a problem'),
          ),
        ]),
      );
}

class CheckoutPage extends StatelessWidget {
  const CheckoutPage({super.key});

  Future<void> _pay(BuildContext context) async {
    try {
      await pb.collection('orders').create(body: {'total': 42});
    } catch (error, stack) {
      PocketBaseReplay.captureException(error, stackTrace: stack, groupingKey: 'checkout-payment');
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Payment failed')));
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Checkout')),
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            // Text fields are always masked.
            const TextField(decoration: InputDecoration(labelText: 'Card number')),
            const SizedBox(height: 16),
            FilledButton(onPressed: () => _pay(context), child: const Text('Pay now')),
          ]),
        ),
      );
}
