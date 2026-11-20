// macOS privacy permissions (camera, microphone, screen recording) and the dock
// badge, for the shim's systemPreferences / app.dock. The Node main process is a
// child of this app, so TCC attributes its use to the app; asking from here is
// asking for the same identity.

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, Bool};
use objc2::msg_send;
use objc2_foundation::NSString;
use serde_json::Value;
use std::sync::mpsc;

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
  fn CGPreflightScreenCaptureAccess() -> bool;
}

// AVMediaTypeAudio / AVMediaTypeVideo are these four-char strings.
fn media_type(kind: &str) -> Option<Retained<NSString>> {
  match kind {
    "microphone" => Some(NSString::from_str("soun")),
    "camera" => Some(NSString::from_str("vide")),
    _ => None,
  }
}

fn capture_device() -> Option<&'static AnyClass> {
  AnyClass::get(c"AVCaptureDevice")
}

pub fn status(kind: &str) -> Result<Value, String> {
  if kind == "screen" {
    // Preflight only says yes or no; it never prompts.
    let ok = unsafe { CGPreflightScreenCaptureAccess() };
    return Ok(Value::from(if ok { "granted" } else { "denied" }));
  }
  let (Some(cls), Some(ty)) = (capture_device(), media_type(kind)) else {
    return Ok(Value::from("unknown"));
  };
  // AVAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied, 3 authorized.
  let st: isize = unsafe { msg_send![cls, authorizationStatusForMediaType: &*ty] };
  Ok(Value::from(match st {
    0 => "not-determined",
    1 => "restricted",
    2 => "denied",
    3 => "granted",
    _ => "unknown",
  }))
}

// Blocks the calling (dispatch worker) thread until the user answers.
pub fn ask(kind: &str) -> Result<Value, String> {
  let (Some(cls), Some(ty)) = (capture_device(), media_type(kind)) else {
    return Ok(Value::Bool(false));
  };
  let (tx, rx) = mpsc::channel::<bool>();
  let block = block2::RcBlock::new(move |granted: Bool| {
    let _ = tx.send(granted.as_bool());
  });
  unsafe {
    let _: () = msg_send![cls, requestAccessForMediaType: &*ty, completionHandler: &*block];
  }
  Ok(Value::Bool(rx.recv().unwrap_or(false)))
}
