.PHONY: install frontend build check

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

check:
	cd frontend && npm run check:bootstrap
