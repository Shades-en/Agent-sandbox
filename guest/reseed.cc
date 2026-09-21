// Reseed Node's own OpenSSL RNG after restoring a cloned runtime. Resolve
// RAND_seed from the Node executable, not a separate copy of libcrypto.
#include <node_api.h>
extern "C" void RAND_seed(const void*, int);

static napi_value reseed(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  bool buffer = false;
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr) != napi_ok ||
      argc != 1 || napi_is_buffer(env, argument, &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, argument, &data, &length) != napi_ok || length != 64) {
    napi_throw_type_error(env, nullptr, "Expected 64 bytes of fresh host entropy");
    return nullptr;
  }
  RAND_seed(data, static_cast<int>(length));
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "reseed", NAPI_AUTO_LENGTH, reseed, nullptr, &function);
  napi_set_named_property(env, exports, "reseed", function);
  return exports;
}
NAPI_MODULE(reseed, init)
