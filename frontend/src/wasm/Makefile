build:
	docker run --rm -v "$$(pwd):/src" -w /src \
		emscripten/emsdk:3.1.74 \
		emcc src/wasm/irradiance.c \
			-O3 \
			--no-entry \
			-s MODULARIZE=1 \
			-s EXPORT_ES6=1 \
			-s EXPORTED_FUNCTIONS='["_irradiance_run","_irradiance_to_resistance","_irradiance_combine","_malloc","_free"]' \
			-s EXPORTED_RUNTIME_METHODS='["HEAPF32","ccall","cwrap","getValue","setValue"]' \
			-s EXPORT_NAME='IrradianceModule' \
			-o src/wasm/irradiance.js
