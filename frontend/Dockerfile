FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
COPY app.js /usr/share/nginx/html/app.js
COPY styles.css /usr/share/nginx/html/styles.css
EXPOSE 8080
# nginx default listens 80, but we expose 8080 for compose frontend profile
RUN sed -i 's/listen .*/listen 8080;/' /etc/nginx/conf.d/default.conf
