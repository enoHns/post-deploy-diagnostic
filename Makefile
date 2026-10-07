IMAGE ?= post-deploy-diagnostic:1.0.1

.PHONY: build test demo up check down package
build:
	docker build -t $(IMAGE) .
test:
	docker build --target test -t post-deploy-diagnostic:test .
	docker run --rm post-deploy-diagnostic:test
demo:
	bash scripts/demo.sh
up:
	docker compose up -d --wait app redis postgres
check:
	docker compose run --rm --no-deps diagnostic
down:
	docker compose down --volumes
package:
	bash scripts/package.sh
