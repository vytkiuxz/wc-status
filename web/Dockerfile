FROM nginx:alpine
# nginx:alpine runs envsubst on /etc/nginx/templates/*.template at startup,
# substituting env vars (WC_DEVICE) into the final config.
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY index.html /usr/share/nginx/html/index.html
