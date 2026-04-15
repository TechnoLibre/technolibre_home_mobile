// Compatibility shim for sentencepiece + Android NDK cross-compilation.
//
// In this build context sentencepiece's common.h uses __has_include to
// optionally pull in absl/log/check.h for DCHECK_* macros.  When the absl
// bundled headers are not found via __has_include (which happens during NDK
// cross-compilation because the sysroot changes where headers are searched),
// the macros are never defined, causing "use of undeclared identifier" errors
// in model_interface.h.
//
// This header is force-included (-include flag) before any sentencepiece TU.
// The guards ensure we don't stomp on real absl definitions if they do load.

#pragma once

#if !defined(DCHECK)
#  define DCHECK(cond)     ((void)(cond))
#endif
#if !defined(DCHECK_EQ)
#  define DCHECK_EQ(a, b)  ((void)(a), (void)(b))
#endif
#if !defined(DCHECK_NE)
#  define DCHECK_NE(a, b)  ((void)(a), (void)(b))
#endif
#if !defined(DCHECK_GE)
#  define DCHECK_GE(a, b)  ((void)(a), (void)(b))
#endif
#if !defined(DCHECK_GT)
#  define DCHECK_GT(a, b)  ((void)(a), (void)(b))
#endif
#if !defined(DCHECK_LE)
#  define DCHECK_LE(a, b)  ((void)(a), (void)(b))
#endif
#if !defined(DCHECK_LT)
#  define DCHECK_LT(a, b)  ((void)(a), (void)(b))
#endif
