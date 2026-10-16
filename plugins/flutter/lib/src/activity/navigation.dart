import 'package:flutter/widgets.dart';

import '../privacy.dart';
import 'activity.dart';

/// Notes screen changes in the recording. Add [PocketBaseReplay.navigatorObserver] to your app's
/// `navigatorObservers`. Pages are named by their route name, such as `/checkout`, without query or fragment; routes
/// without a name, dialogs and sheets are not noted.
class ReplayNavigatorObserver extends NavigatorObserver {
  static String _current = '/';

  /// The address of the screen shown last, which also names the page a full snapshot is taken on.
  static String get currentUrl => clip(
      cleanUrl('$screenOrigin$_current', ActivityRecorder.current?.privateText() ?? const []), ActivityLimits.urlChars);

  /// The recorded address for a route name: a path, without query or fragment, with token-like parts masked.
  static String? urlFor(String? name) {
    final path = _pathFor(name);
    if (path == null) return null;
    return clip(cleanUrl('$screenOrigin$path', ActivityRecorder.current?.privateText() ?? const []), ActivityLimits.urlChars);
  }

  static String? _pathFor(String? name) {
    if (name == null) return null;
    var path = name.split(RegExp('[?#]')).first.trim();
    if (path.isEmpty) return null;
    if (!path.startsWith('/')) path = '/$path';
    // Redact before clipping the serialized address: clipping here could leave only the beginning of a secret.
    return path;
  }

  void _show(Route<dynamic>? route) {
    if (route is! PageRoute) return;
    final path = _pathFor(route.settings.name);
    if (path == null) return;
    _current = path;
    ActivityRecorder.current?.navigation(currentUrl);
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => _show(route);

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    // Closing a dialog or sheet leaves the same page on screen.
    if (route is PageRoute) _show(previousRoute);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) => _show(newRoute);
}
