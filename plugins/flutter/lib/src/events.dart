/// One rrweb event, the format the replay viewer plays.
class ReplayEvent {
  const ReplayEvent(this.type, this.timestamp, this.data);

  final int type;
  final int timestamp;
  final Map<String, Object?> data;

  Map<String, Object?> toJson() => {'type': type, 'timestamp': timestamp, 'data': data};
}

abstract final class EventType {
  static const int fullSnapshot = 2;
  static const int incrementalSnapshot = 3;
  static const int meta = 4;
  static const int custom = 5;
}

abstract final class IncrementalSource {
  static const int mutation = 0;
  static const int mouseMove = 1;
  static const int mouseInteraction = 2;
  static const int touchMove = 6;
}

abstract final class MouseInteraction {
  static const int mouseUp = 0;
  static const int mouseDown = 1;
  static const int click = 2;
  static const int dblClick = 4;
  static const int touchStart = 7;
  static const int touchEnd = 9;
  static const int touchCancel = 10;
}

ReplayEvent customEvent(String tag, Map<String, Object?> payload, int timestamp) =>
    ReplayEvent(EventType.custom, timestamp, {'tag': tag, 'payload': payload});
